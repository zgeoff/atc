import { expect, onTestFinished, test } from 'bun:test';
import { copyFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import {
  getRecord,
  getString,
  resolveATCCommand,
  runATC,
  setupTempDir,
  waitForEvent,
} from '@atc/test-utils';
import { startStubAgentDaemon } from '../packages/app/src/test-utils/start-stub-agent-daemon';

// The source and the fresh daemon run in the test's process, and only the
// backup command runs as a process.
async function setupTest() {
  const source = await startStubAgentDaemon();
  const fresh = await startStubAgentDaemon();

  const cliHome = setupTempDir('atc-e2e-backup-cli-').path;
  const work = setupTempDir('atc-e2e-backup-work-').path;

  // The command finds its daemon at the socket under its runtime directory.
  symlinkSync(source.daemon.socketPath, join(cliHome, 'atc-daemon.sock'));

  return { atc: resolveATCCommand(), source, fresh, cliHome, work };
}

test('it backs up a running daemon to a file that a fresh daemon restores with every session row', async () => {
  const ctx = await setupTest();

  const client = ctx.source.daemon.client;
  const events = ctx.source.daemon.events;

  // Each session reports its own atc session id as its agent session, so the
  // two sessions keep two fleet rows.
  ctx.source.agents.useOwnID();

  await client.sendRequest('session.spawn', {
    cwd: ctx.work,
    name: 'kept running',
    cols: 80,
    rows: 24,
  });

  await waitForEvent(events, {
    ev: 'SessionState',
    session: { name: 'kept running', state: 'needs_you' },
  });

  ctx.source.agents.useOwnID();

  const killed = await client.sendRequest('session.spawn', {
    cwd: ctx.work,
    name: 'killed before the backup',
    cols: 80,
    rows: 24,
  });

  await waitForEvent(events, {
    ev: 'SessionState',
    session: { name: 'killed before the backup', state: 'needs_you' },
  });

  await client.sendRequest('session.kill', {
    session: getString(getRecord(killed, 'session'), 'id'),
  });

  await waitForEvent(events, {
    ev: 'SessionState',
    session: { name: 'killed before the backup', lastMsg: 'killed' },
  });

  const sourceProbe = await openDaemonClient(ctx.source.daemon.socketPath);

  onTestFinished(() => {
    sourceProbe.stop();
  });

  const sourceHello = await sourceProbe.sendHello('atc/test');
  const sourceFleet = await client.sendRequest('fleet.list');

  const backup = await runATC({
    command: ctx.atc,
    args: ['backup', 'atc-backup.db'],
    home: ctx.cliHome,
    cwd: ctx.work,
  });

  // The rest of the journey reads the file this step writes, so its result
  // is checked before the journey goes on.
  expect(backup.stderr).toBe('');
  expect(backup.exitCode).toBe(0);
  expect(backup.stdout).toMatch(/^atc backup: wrote \d+ bytes to .*\/atc-backup\.db\n$/u);

  await ctx.fresh.daemon.stop();

  copyFileSync(join(ctx.work, 'atc-backup.db'), ctx.fresh.daemon.dbPath);

  await ctx.fresh.daemon.restart();

  const freshClient = await openDaemonClient(ctx.fresh.daemon.socketPath);

  onTestFinished(() => {
    freshClient.stop();
  });

  const freshHello = await freshClient.sendHello('atc/test');
  const freshFleet = await freshClient.sendRequest('fleet.list');
  const restored = await freshClient.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  const listed = await freshClient.sendRequest('session.list');

  expect(freshHello['daemonID']).toBe(sourceHello['daemonID']);
  expect(freshFleet).toStrictEqual(sourceFleet);
  expect(restored).toStrictEqual({ restored: 2 });

  expect(listed).toMatchObject({
    sessions: expect.toIncludeAllPartialMembers([
      { name: 'kept running', alive: true },
      { name: 'killed before the backup', state: 'exited', alive: false },
    ]),
  });
});
