import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemonProcess } from '@atc/lifecycle/testing';
import type { EventMsg } from '@atc/protocol/wire';
import {
  createStubClaude,
  createStubComposer,
  getRecord,
  getString,
  resolveATCCommand,
  runATC,
  setupTempDir,
  waitForEvent,
} from '@atc/test-utils';

/**
 * Two fresh homes, each with a stub Claude CLI and the config directory its
 * daemon reads, and a working directory both daemons can start sessions in.
 */
function setupTest() {
  const atc = resolveATCCommand();
  const work = setupTempDir('atc-e2e-backup-work-').dir;

  const buildHome = (prefix: string) => {
    const home = setupTempDir(prefix).dir;
    const composer = createStubComposer(home);
    const configDir = join(home, '.config', 'atc');

    mkdirSync(configDir, { recursive: true });

    return {
      home,
      configPath: join(configDir, 'config.json'),
      stateDir: join(home, '.local', 'state', 'atc'),
      claude: createStubClaude(home, { atc, composer }),
    };
  };

  return {
    atc,
    work,
    source: buildHome('atc-e2e-backup-source-'),
    fresh: buildHome('atc-e2e-backup-fresh-'),
  };
}

test('it backs up a running daemon to a file that a fresh daemon restores with every session row', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.source.configPath,
    JSON.stringify({ agents: { claude: { bin: ctx.source.claude } } }),
  );

  // Each stub reports its own atc session id as its agent session, so the
  // two sessions keep two fleet rows.
  writeFileSync(join(ctx.source.home, 'fake-claude-own-id'), '');

  const source = startDaemonProcess({ command: ctx.atc, home: ctx.source.home });

  const client = await source.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

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

  const sourceHello = await client.sendRequest('daemon.hello', { client: 'atc/test' });
  const sourceFleet = await client.sendRequest('fleet.list');

  const backup = await runATC({
    command: ctx.atc,
    args: ['backup', 'atc-backup.db'],
    home: ctx.source.home,
    cwd: ctx.work,
  });

  // The rest of the journey reads the file this step writes, so its result
  // is checked before the journey goes on.
  expect(backup).toStrictEqual({
    exitCode: 0,
    stdout: expect.stringMatching(/^atc backup: wrote \d+ bytes to .*\/atc-backup\.db\n$/),
    stderr: '',
  });

  writeFileSync(
    ctx.fresh.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.fresh.claude } },

      // The fresh daemon restores only when the test asks it to.
      restoreFleetOnRestart: false,
    }),
  );

  mkdirSync(ctx.fresh.stateDir, { recursive: true });
  copyFileSync(join(ctx.work, 'atc-backup.db'), join(ctx.fresh.stateDir, 'atc.db'));

  const fresh = startDaemonProcess({ command: ctx.atc, home: ctx.fresh.home });

  const freshClient = await fresh.openClient();
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
