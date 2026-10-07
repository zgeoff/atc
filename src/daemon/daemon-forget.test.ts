import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import type { HeadlessRunner } from '../agents/agent-adapter';
import { DaemonClient } from '../client/daemon-client';
import { DaemonError } from '../protocol/daemon-error';
import { collectPrincipals } from '../shared/collect-principals';
import { getRecord } from '../shared/get-record';
import { startDaemon } from './daemon';
import type { ExecutionProvider } from './execution-provider';
import { LocalPTYProvider } from './local-pty-provider';

// A real daemon whose one target runs on the provider the test hands it,
// with a fake claude that idles, confirm tokens that live as long as the
// test asks, the headless runner the test hands it, if any, and the raw
// `principals` config the test hands it, if any.
async function setupTest(
  provider: ExecutionProvider,
  forgetConfirmMs?: number,
  headlessRunner: HeadlessRunner | null = null,
  principals?: unknown,
) {
  const tmp = setupTempDir('atc-daemon-forget-');
  const sockPath = join(tmp.dir, 'daemon.sock');
  const fakeClaude = join(tmp.dir, 'fake-claude');

  writeFileSync(fakeClaude, '#!/usr/bin/env bash\nexec sleep 300\n', { mode: 0o755 });

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: {
      id: 'claude',
      headlessRunner,
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
    targets: [{ id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider }],
    ...(forgetConfirmMs === undefined ? {} : { forgetConfirmMs }),
    ejectSettleMs: 30,
    principals: collectPrincipals(principals).principals,
  });

  const client = await DaemonClient.open(sockPath);

  await client.sendHello('atc/test-build');

  return {
    client,
    dir: tmp.dir,
    async [Symbol.asyncDispose]() {
      client.stop();

      await daemon.stop();

      tmp[Symbol.dispose]();
    },
  };
}

test('it answers a forget on a host-destroying target with a token and destroys nothing yet', async () => {
  const local = new LocalPTYProvider();

  const destroyed: string[] = [];

  await using daemon = await setupTest({
    kind: 'imp-like',
    remote: false,
    prepareHost: local.prepareHost,
    dispose: local.dispose,
    capabilities: { ...local.capabilities, suspend: true, destroy: true },
    spawnHarness: local.spawnHarness,
    transferArchive: local.transferArchive,
    runCommand: local.runCommand,
    suspendHost: () => Promise.resolve(),
    destroyHost: (host) => {
      destroyed.push(host);

      return Promise.resolve();
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.kill', { session: id });

  const askedAt = Date.now();

  const answer = await daemon.client.sendRequest('session.forget', { session: id });

  expect(answer).toStrictEqual({
    confirmToken: expect.toBeString(),
    expiresAt: expect.toBeWithin(askedAt + 60_000, Date.now() + 60_001),
  });

  expect(destroyed).toBeEmpty();

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id })],
  });
});

test('it destroys the host and forgets the session when the forget carries its token', async () => {
  const local = new LocalPTYProvider();

  const destroyed: string[] = [];

  await using daemon = await setupTest({
    kind: 'imp-like',
    remote: false,
    prepareHost: local.prepareHost,
    dispose: local.dispose,
    capabilities: { ...local.capabilities, suspend: true, destroy: true },
    spawnHarness: local.spawnHarness,
    transferArchive: local.transferArchive,
    runCommand: local.runCommand,
    suspendHost: () => Promise.resolve(),
    destroyHost: (host) => {
      destroyed.push(host);

      return Promise.resolve();
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.kill', { session: id });

  const offered = await daemon.client.sendRequest('session.forget', { session: id });

  const forgotten = await daemon.client.sendRequest('session.forget', {
    session: id,
    confirmToken: offered['confirmToken'],
  });

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: true });
  expect<readonly unknown[]>(destroyed).toStrictEqual([id]);
  expect(daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
  expect(daemon.client.sendRequest('fleet.list')).resolves.toStrictEqual({ fleet: [] });
});

test('it refuses a confirm token a forget already took', async () => {
  const local = new LocalPTYProvider();

  let failDestroy = true;

  await using daemon = await setupTest({
    kind: 'imp-like',
    remote: false,
    prepareHost: local.prepareHost,
    dispose: local.dispose,
    capabilities: { ...local.capabilities, suspend: true, destroy: true },
    spawnHarness: local.spawnHarness,
    transferArchive: local.transferArchive,
    runCommand: local.runCommand,
    suspendHost: () => Promise.resolve(),
    destroyHost: () => {
      if (failDestroy) {
        failDestroy = false;

        return Promise.reject(new Error('the host did not answer'));
      }

      return Promise.resolve();
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const offered = await daemon.client.sendRequest('session.forget', { session: id });

  const failed = daemon.client.sendRequest('session.forget', {
    session: id,
    confirmToken: offered['confirmToken'],
  });

  expect(failed).rejects.toMatchObject({ code: 'internal' });

  await failed.catch(() => null);

  expect(
    daemon.client.sendRequest('session.forget', {
      session: id,
      confirmToken: offered['confirmToken'],
    }),
  ).rejects.toMatchObject({ code: 'confirm_token_invalid', data: { reason: 'used' } });

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id })],
  });
});

test('it refuses a confirm token past its lifetime', async () => {
  const local = new LocalPTYProvider();

  const destroyed: string[] = [];

  await using daemon = await setupTest(
    {
      kind: 'imp-like',
      remote: false,
      prepareHost: local.prepareHost,
      dispose: local.dispose,
      capabilities: { ...local.capabilities, suspend: true, destroy: true },
      spawnHarness: local.spawnHarness,
      transferArchive: local.transferArchive,
      runCommand: local.runCommand,
      suspendHost: () => Promise.resolve(),
      destroyHost: (host) => {
        destroyed.push(host);

        return Promise.resolve();
      },
    },
    50,
  );

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const offered = await daemon.client.sendRequest('session.forget', { session: id });

  const expiresAt = offered['expiresAt'];

  await waitFor(() => {
    expect(Date.now()).toBeGreaterThan(Number(expiresAt));
  });

  expect(
    daemon.client.sendRequest('session.forget', {
      session: id,
      confirmToken: offered['confirmToken'],
    }),
  ).rejects.toMatchObject({ code: 'confirm_token_invalid', data: { reason: 'expired' } });

  expect(destroyed).toBeEmpty();
});

test('it refuses a confirm token handed out for another session', async () => {
  const local = new LocalPTYProvider();

  await using daemon = await setupTest({
    kind: 'imp-like',
    remote: false,
    prepareHost: local.prepareHost,
    dispose: local.dispose,
    capabilities: { ...local.capabilities, suspend: true, destroy: true },
    spawnHarness: local.spawnHarness,
    transferArchive: local.transferArchive,
    runCommand: local.runCommand,
    suspendHost: () => Promise.resolve(),
    destroyHost: () => Promise.resolve(),
  });

  const first = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const second = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const offered = await daemon.client.sendRequest('session.forget', {
    session: getRecord(first, 'session')['id'],
  });

  expect(
    daemon.client.sendRequest('session.forget', {
      session: getRecord(second, 'session')['id'],
      confirmToken: offered['confirmToken'],
    }),
  ).rejects.toMatchObject({ code: 'confirm_token_invalid', data: { reason: 'unknown' } });
});

test('it forgets a session on the local target at once without a token', async () => {
  await using daemon = await setupTest(new LocalPTYProvider());

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const forgotten = await daemon.client.sendRequest('session.forget', { session: id });

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: false });
  expect(daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it refuses a forget of a session the daemon does not hold', async () => {
  await using daemon = await setupTest(new LocalPTYProvider());

  expect(
    daemon.client.sendRequest('session.forget', { session: 'no-such-session' }),
  ).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it refuses a forget that refuses a pinned session when a pin lands after the session was read', async () => {
  await using daemon = await setupTest(new LocalPTYProvider());

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.kill', { session: id });

  const read = await daemon.client.sendRequest('session.get', { session: id });

  await daemon.client.sendRequest('session.update', { session: id, pinned: true });

  const refused = daemon.client.sendRequest('session.forget', {
    session: id,
    refusePinned: true,
    refuseLive: true,
  });

  expect(read).toMatchObject({ session: { id, pinned: false, alive: false } });
  expect(refused).rejects.toMatchObject({ code: 'session_pinned', data: { session: id } });

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, pinned: true })],
  });
});

test('it refuses a forget that refuses a pinned session of a sub-session of a pinned session', async () => {
  await using daemon = await setupTest(new LocalPTYProvider());

  const spawnedParent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const parent = getRecord(spawnedParent, 'session')['id'];

  const spawnedChild = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    parent,
  });

  const child = getRecord(spawnedChild, 'session')['id'];

  await daemon.client.sendRequest('session.update', { session: parent, pinned: true });

  const refused = daemon.client.sendRequest('session.forget', {
    session: child,
    refusePinned: true,
  });

  expect(refused).rejects.toMatchObject({ code: 'session_pinned' });

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id: parent }), expect.objectContaining({ id: child })],
  });
});

test('it refuses a forget that refuses a live session when the session is live', async () => {
  await using daemon = await setupTest(new LocalPTYProvider());

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const refused = daemon.client.sendRequest('session.forget', {
    session: id,
    refusePinned: true,
    refuseLive: true,
  });

  expect(refused).rejects.toMatchObject({ code: 'session_live', data: { session: id } });

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, alive: true })],
  });
});

test('it forgets a dead unpinned session when the forget refuses pinned and live sessions', async () => {
  await using daemon = await setupTest(new LocalPTYProvider());

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.kill', { session: id });

  const forgotten = await daemon.client.sendRequest('session.forget', {
    session: id,
    refusePinned: true,
    refuseLive: true,
  });

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: false });
  expect(daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it refuses a pinned session on a host-destroying target before it hands out a token', async () => {
  const local = new LocalPTYProvider();

  await using daemon = await setupTest({
    kind: 'imp-like',
    remote: false,
    prepareHost: local.prepareHost,
    dispose: local.dispose,
    capabilities: { ...local.capabilities, suspend: true, destroy: true },
    spawnHarness: local.spawnHarness,
    transferArchive: local.transferArchive,
    runCommand: local.runCommand,
    suspendHost: () => Promise.resolve(),
    destroyHost: () => Promise.resolve(),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.update', { session: id, pinned: true });

  const refused = daemon.client.sendRequest('session.forget', {
    session: id,
    refusePinned: true,
  });

  expect(refused).rejects.toMatchObject({ code: 'session_pinned' });
});

test('it keeps a headless run going when the forget of its session fails to destroy the host', async () => {
  const local = new LocalPTYProvider();

  const runs: { stopped: boolean }[] = [];

  await using daemon = await setupTest(
    {
      kind: 'imp-like',
      remote: false,
      capabilities: { ...local.capabilities, suspend: true, destroy: true },
      prepareHost: () => Promise.resolve(),
      spawnHarness: local.spawnHarness,
      transferArchive: local.transferArchive,
      runCommand: local.runCommand,
      suspendHost: () => Promise.resolve(),
      destroyHost: () => Promise.reject(new Error('impd is unreachable')),
      dispose: () => {},
    },
    undefined,
    (_opts, hooks) => {
      const run = { stopped: false };

      runs.push(run);
      hooks.onOutput('HEADLESS LINE\r\n');

      return {
        stop() {
          run.stopped = true;
        },
      };
    },
  );

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    resume: 'agent-1',
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.eject', { session: id });

  await waitFor(() => {
    expect(runs).toHaveLength(1);
  });

  const offered = await daemon.client.sendRequest('session.forget', { session: id });

  const forgotten = daemon.client.sendRequest('session.forget', {
    session: id,
    confirmToken: offered['confirmToken'],
  });

  expect(forgotten).rejects.toThrow();

  await forgotten.catch(() => null);

  expect(runs).toStrictEqual([{ stopped: false }]);

  expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, kind: 'headless' }],
  });
});

test.each([
  ['without a token', false],
  ['with the token the owner was handed', true],
])(
  'it answers a principal forget %s of a session on a target it may not use as for a session that does not exist, destroying nothing',
  async (_label, withToken) => {
    const local = new LocalPTYProvider();

    const destroyed: string[] = [];

    await using daemon = await setupTest(
      {
        kind: 'imp-like',
        remote: false,
        prepareHost: local.prepareHost,
        dispose: local.dispose,
        capabilities: { ...local.capabilities, suspend: true, destroy: true },
        spawnHarness: local.spawnHarness,
        transferArchive: local.transferArchive,
        runCommand: local.runCommand,
        suspendHost: () => Promise.resolve(),
        destroyHost: (host) => {
          destroyed.push(host);

          return Promise.resolve();
        },
      },
      undefined,
      null,
      { outsider: { targets: [] } },
    );

    const spawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      cols: 80,
      rows: 24,
    });

    const id = String(getRecord(spawned, 'session')['id']);
    const missing = 'no-such-session';

    await daemon.client.sendRequest('session.kill', { session: id });

    const offered = await daemon.client.sendRequest('session.forget', { session: id });

    const token = withToken ? { confirmToken: offered['confirmToken'] } : {};

    const answered = await daemon.client
      .sendRequest('session.forget', { session: id, ...token }, 'outsider')
      .then(
        (ok) => ({ ok }),
        (error: unknown) => ({
          error:
            error instanceof DaemonError
              ? { code: error.code, message: error.message, data: error.data ?? null }
              : error,
        }),
      );

    const unknown = await daemon.client
      .sendRequest('session.forget', { session: missing, ...token }, 'outsider')
      .then(
        (ok) => ({ ok }),
        (error: unknown) => ({
          error:
            error instanceof DaemonError
              ? { code: error.code, message: error.message, data: error.data ?? null }
              : error,
        }),
      );

    expect(JSON.parse(JSON.stringify(answered).replaceAll(id, '<session>'))).toStrictEqual(
      JSON.parse(JSON.stringify(unknown).replaceAll(missing, '<session>')),
    );

    expect(destroyed).toBeEmpty();

    expect(daemon.client.sendRequest('session.list')).resolves.toMatchObject({
      sessions: [expect.objectContaining({ id })],
    });
  },
);

test('it destroys the host when a principal that may use its target forgets with the token', async () => {
  const local = new LocalPTYProvider();

  const destroyed: string[] = [];

  await using daemon = await setupTest(
    {
      kind: 'imp-like',
      remote: false,
      prepareHost: local.prepareHost,
      dispose: local.dispose,
      capabilities: { ...local.capabilities, suspend: true, destroy: true },
      spawnHarness: local.spawnHarness,
      transferArchive: local.transferArchive,
      runCommand: local.runCommand,
      suspendHost: () => Promise.resolve(),
      destroyHost: (host) => {
        destroyed.push(host);

        return Promise.resolve();
      },
    },
    undefined,
    null,
    { insider: { targets: ['local'] } },
  );

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.kill', { session: id });

  const offered = await daemon.client.sendRequest('session.forget', { session: id }, 'insider');

  const forgotten = await daemon.client.sendRequest(
    'session.forget',
    { session: id, confirmToken: offered['confirmToken'] },
    'insider',
  );

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: true });
  expect<readonly unknown[]>(destroyed).toStrictEqual([id]);
  expect(daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});
