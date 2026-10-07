import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { getRecord } from '../shared/get-record';
import { FixtureImpPort } from '../test-utils/fixture-imp-port';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startDaemon } from './daemon';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';

// A real daemon with three targets: `local` on the daemon's machine, the
// default, and two imp targets, `box` and `other`, over one fixture imp
// port, so every imp either one makes lists in the same place.
async function setupTest() {
  const tmp = setupTempDir('atc-imp-placement-');
  const sockPath = join(tmp.dir, 'daemon.sock');
  const fakeClaude = join(tmp.dir, 'fake-claude');

  const port = new FixtureImpPort();

  writeFileSync(fakeClaude, '#!/usr/bin/env bash\necho UP\nexec cat\n', { mode: 0o755 });

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: {
      id: 'claude',
      headlessRunner: null,
      screenDetector: null,
      takesMessages: false,
      planSpawn: () => ({ bin: fakeClaude, args: [] }),
      normalizeHook: () => ({ kind: 'heartbeat' }),
      loadName: () => Promise.resolve(null),
      canResume: () => true,
      buildResumeCommand: () => null,
    },
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
    targets: [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: 'local-pty:test',
        provider: new LocalPTYProvider(),
      },
      ...['box', 'other'].map((id) => ({
        id,
        kind: 'imp',
        options: { image: id },
        identity: `imp:${id}`,
        provider: new ImpProvider(port, { guestDir: join(tmp.dir, id) }),
      })),
    ],
    defaultTarget: 'local',
  });

  const client = await DaemonClient.open(sockPath);

  await client.sendHello('atc/test-build');

  return {
    client,
    port,
    dir: tmp.dir,
    async [Symbol.asyncDispose]() {
      client.stop();

      await daemon.stop();

      port[Symbol.dispose]();
      tmp[Symbol.dispose]();
    },
  };
}

test("it runs a sub-session on its parent's target as another session in its parent's imp", async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
  });

  const [imp] = daemon.port.collectImpNames();

  expect(daemon.port.collectImpNames()).toHaveLength(1);

  expect<readonly unknown[]>(
    daemon.port.sessionRequests.map((request) => request.name),
  ).toStrictEqual([imp, imp]);

  expect(new Set(daemon.port.sessionRequests.map((request) => request.session)).size).toBe(2);
});

test("it wakes a sleeping parent's imp to start a sub-session there", async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const [imp] = daemon.port.collectImpNames();

  await daemon.client.sendRequest('session.kill', { session: parentID });

  expect(daemon.port.findState(String(imp))).toBe('sleeping');

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
    parent: parentID,
  });

  expect<readonly unknown[]>(daemon.port.collectImpNames()).toStrictEqual([imp]);
  expect(daemon.port.findState(String(imp))).toBe('running');
});

test('it gives a sub-session without a target a host of its own on the default target', async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  const child = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    parent: getRecord(parent, 'session')['id'],
  });

  expect(getRecord(getRecord(child, 'session'), 'locator')).toMatchObject({ targetID: 'local' });
  expect(daemon.port.collectImpNames()).toHaveLength(1);
  expect(daemon.port.sessionRequests).toHaveLength(1);
});

test('it gives a sub-session on another imp target an imp of its own', async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    target: 'box',
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    target: 'other',
    parent: getRecord(parent, 'session')['id'],
  });

  expect(daemon.port.collectImpNames()).toHaveLength(2);
});
