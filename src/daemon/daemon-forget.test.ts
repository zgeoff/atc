import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { DaemonClient } from '../client/daemon-client';
import { getRecord } from '../shared/get-record';
import { startDaemon } from './daemon';
import type { ExecutionProvider } from './execution-provider';
import { LocalPTYProvider } from './local-pty-provider';

// A real daemon whose one target runs on the provider the test hands it,
// with a fake claude that idles, and confirm tokens that live as long as
// the test asks.
async function setupTest(provider: ExecutionProvider, forgetConfirmMs?: number) {
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
    targets: [{ id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider }],
    ...(forgetConfirmMs === undefined ? {} : { forgetConfirmMs }),
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
