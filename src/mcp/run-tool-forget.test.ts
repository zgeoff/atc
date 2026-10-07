import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { DaemonClient } from '../client/daemon-client';
import { startDaemon } from '../daemon/daemon';
import { LocalPTYProvider } from '../daemon/local-pty-provider';
import { collectPrincipals } from '../shared/collect-principals';
import { getRecord } from '../shared/get-record';
import { buildPrincipalCaller } from './build-principal-caller';
import { ReconnectingCaller } from './reconnecting-caller';
import { runTool } from './run-tool';

// A real daemon with one target and `atc mcp`'s caller in front of it. The
// target is the plain local one, or, with `destroys`, one whose provider can
// destroy its host and records each host it destroys.
async function setupTest(destroys: boolean, principals?: unknown) {
  const tmp = setupTempDir('atc-run-tool-forget-');
  const socketPath = join(tmp.dir, 'daemon.sock');

  const local = new LocalPTYProvider();

  const destroyed: string[] = [];

  const provider = destroys
    ? {
        kind: 'imp-like',
        remote: false,
        prepareHost: local.prepareHost,
        dispose: local.dispose,
        capabilities: { ...local.capabilities, suspend: true, destroy: true },
        spawnHarness: local.spawnHarness,
        transferArchive: local.transferArchive,
        runCommand: local.runCommand,
        suspendHost: () => Promise.resolve(),
        destroyHost: (host: string) => {
          destroyed.push(host);

          return Promise.resolve();
        },
      }
    : local;

  const daemon = await startDaemon({
    socketPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: {
      id: 'claude',
      headlessRunner: null,
      screenDetector: null,
      takesMessages: false,
      planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
      normalizeHook: () => ({ kind: 'heartbeat' }),
      loadName: () => Promise.resolve(null),
      canResume: () => true,
      buildResumeCommand: () => null,
    },
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
    targets: [{ id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider }],
    principals: collectPrincipals(principals).principals,
  });

  const caller = new ReconnectingCaller(socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  return {
    caller,
    cwd: tmp.dir,
    destroyed,
    context: { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } } as const,
    async [Symbol.asyncDispose]() {
      await caller.stop();
      await daemon.stop();

      tmp[Symbol.dispose]();
    },
  };
}

test('it hands out a token and changes nothing for a live session on a host-destroying target', async () => {
  await using fleet = await setupTest(true);

  const spawned = await fleet.caller.sendRequest('session.spawn', {
    cwd: fleet.cwd,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const offered = await runTool(
    fleet.caller,
    'atc_session_forget',
    { session: id, stop: true },
    fleet.context,
  );

  const listed = await fleet.caller.sendRequest('session.list');

  expect(offered.structured).toStrictEqual({
    confirmToken: expect.toBeString(),
    expiresAt: expect.toBeNumber(),
  });

  expect(fleet.destroyed).toBeEmpty();

  expect(listed).toMatchObject({
    sessions: [expect.objectContaining({ id, alive: true })],
  });
});

test('it destroys the host and drops the live session when the second call carries the token', async () => {
  await using fleet = await setupTest(true);

  const spawned = await fleet.caller.sendRequest('session.spawn', {
    cwd: fleet.cwd,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const offered = await runTool(
    fleet.caller,
    'atc_session_forget',
    { session: id, stop: true },
    fleet.context,
  );

  const forgotten = await runTool(
    fleet.caller,
    'atc_session_forget',
    { session: id, stop: true, confirmToken: offered.structured?.['confirmToken'] },
    fleet.context,
  );

  const listed = await runTool(fleet.caller, 'atc_session_list', {}, fleet.context);

  expect(forgotten.structured).toStrictEqual({ forgotten: true, destroyed: true });
  expect<readonly unknown[]>(fleet.destroyed).toStrictEqual([id]);
  expect(listed.structured).toStrictEqual({ sessions: [] });
});

test('it hands out a token for a dead session on a host-destroying target and changes nothing', async () => {
  await using fleet = await setupTest(true);

  const spawned = await fleet.caller.sendRequest('session.spawn', {
    cwd: fleet.cwd,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await fleet.caller.sendRequest('session.kill', { session: id });

  const offered = await runTool(fleet.caller, 'atc_session_forget', { session: id }, fleet.context);

  expect(offered.structured).toStrictEqual({
    confirmToken: expect.toBeString(),
    expiresAt: expect.toBeNumber(),
  });

  expect(fleet.destroyed).toBeEmpty();
});

test('it forgets a dead session on a local target in one call', async () => {
  await using fleet = await setupTest(false);

  const spawned = await fleet.caller.sendRequest('session.spawn', {
    cwd: fleet.cwd,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await fleet.caller.sendRequest('session.kill', { session: id });

  const forgotten = await runTool(
    fleet.caller,
    'atc_session_forget',
    { session: id },
    fleet.context,
  );

  const listed = await runTool(fleet.caller, 'atc_session_list', {}, fleet.context);

  expect(forgotten.structured).toStrictEqual({ forgotten: true, destroyed: false });
  expect(listed.structured).toStrictEqual({ sessions: [] });
});

test('it stops and forgets a live session on a local target in one call when stop is true', async () => {
  await using fleet = await setupTest(false);

  const spawned = await fleet.caller.sendRequest('session.spawn', {
    cwd: fleet.cwd,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const forgotten = await runTool(
    fleet.caller,
    'atc_session_forget',
    { session: id, stop: true },
    fleet.context,
  );

  const listed = await runTool(fleet.caller, 'atc_session_list', {}, fleet.context);

  expect(forgotten.structured).toStrictEqual({ forgotten: true, destroyed: false });
  expect(listed.structured).toStrictEqual({ sessions: [] });
});

test('it refuses a live session without stop and leaves it running', async () => {
  await using fleet = await setupTest(true);

  const spawned = await fleet.caller.sendRequest('session.spawn', {
    cwd: fleet.cwd,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const refused = runTool(fleet.caller, 'atc_session_forget', { session: id }, fleet.context);

  expect(refused).rejects.toThrowWithMessage(Error, /^session_live: .*stop: true/);

  const listed = await fleet.caller.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: [expect.objectContaining({ id, alive: true })],
  });
});

test('it refuses a pinned session and leaves it listed', async () => {
  await using fleet = await setupTest(false);

  const spawned = await fleet.caller.sendRequest('session.spawn', {
    cwd: fleet.cwd,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await fleet.caller.sendRequest('session.update', { session: id, pinned: true });

  const refused = runTool(
    fleet.caller,
    'atc_session_forget',
    { session: id, stop: true },
    fleet.context,
  );

  expect(refused).rejects.toThrowWithMessage(Error, /^session_pinned: .*atc_session_update/);

  const listed = await fleet.caller.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: [expect.objectContaining({ id, pinned: true, alive: true })],
  });
});

test('it refuses a sub-session of a pinned session and leaves both listed', async () => {
  await using fleet = await setupTest(false);

  const spawnedParent = await fleet.caller.sendRequest('session.spawn', {
    cwd: fleet.cwd,
    cols: 80,
    rows: 24,
  });

  const parent = getRecord(spawnedParent, 'session')['id'];

  const spawnedChild = await fleet.caller.sendRequest('session.spawn', {
    cwd: fleet.cwd,
    cols: 80,
    rows: 24,
    parent,
  });

  const child = getRecord(spawnedChild, 'session')['id'];

  await fleet.caller.sendRequest('session.update', { session: parent, pinned: true });

  const refused = runTool(
    fleet.caller,
    'atc_session_forget',
    { session: child, stop: true },
    fleet.context,
  );

  expect(refused).rejects.toThrowWithMessage(Error, /^session_pinned: /);

  const listed = await fleet.caller.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: [expect.objectContaining({ id: parent }), expect.objectContaining({ id: child })],
  });
});

test('it refuses an unknown session as no_such_session before any token exists', async () => {
  await using fleet = await setupTest(true);

  const refused = runTool(
    fleet.caller,
    'atc_session_forget',
    { session: 'nope', stop: true },
    fleet.context,
  );

  expect(refused).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it refuses a principal a session on a target it cannot use as no_such_session and keeps the session', async () => {
  await using fleet = await setupTest(true, { outsider: { targets: ['elsewhere'] } });

  const spawned = await fleet.caller.sendRequest('session.spawn', {
    cwd: fleet.cwd,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const refused = runTool(
    buildPrincipalCaller(fleet.caller, 'outsider'),
    'atc_session_forget',
    { session: id, stop: true },
    fleet.context,
  );

  expect(refused).rejects.toMatchObject({ code: 'no_such_session' });

  const listed = await fleet.caller.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: [expect.objectContaining({ id, alive: true })],
  });

  expect(fleet.destroyed).toBeEmpty();
});
