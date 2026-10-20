import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { systemClock } from '@atc/core';
import { PROTOCOL_V } from '@atc/protocol/wire';
import {
  buildStubClock,
  registerTestCleanup,
  setupTempDir,
  startStubLegacyDaemon,
  startStubUnansweringUnixListener,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { tryOpenDaemon } from './try-open-daemon';

// A temp directory for the sockets.
function setupTest() {
  const dir = setupTempDir('try-open-daemon-').path;

  return { dir };
}

test('it returns the hello and what the read returns from the daemon that answers', async () => {
  const ctx = setupTest();

  startStubLegacyDaemon(join(ctx.dir, 'atc-daemon.sock'), {
    replies: {
      'daemon.hello': { daemon: 'atc/1.2.3', daemonID: 'd-1' },
      'session.list': { sessions: [] },
    },
  });

  const probe = await tryOpenDaemon(
    [join(ctx.dir, 'atc-daemon.sock')],
    { build: 'atc/test-build', deadline: systemClock.now() + 3000, clock: systemClock },
    (client) => client.sendRequest('session.list'),
  );

  expect(probe).toStrictEqual({
    kind: 'ok',
    socketPath: join(ctx.dir, 'atc-daemon.sock'),
    hello: { build: 'atc/1.2.3', daemonID: 'd-1' },
    value: { sessions: [] },
  });
});

test('it refuses a daemon whose hello holds no build or id, and reads nothing from it', async () => {
  const ctx = setupTest();

  startStubLegacyDaemon(join(ctx.dir, 'atc-daemon.sock'), {
    replies: { 'daemon.hello': {} },
  });

  const read = mock(() => Promise.resolve(null));

  const probe = await tryOpenDaemon(
    [join(ctx.dir, 'atc-daemon.sock')],
    { build: 'atc/test-build', deadline: systemClock.now() + 3000, clock: systemClock },
    read,
  );

  expect(probe).toStrictEqual({
    kind: 'refused',
    socketPath: join(ctx.dir, 'atc-daemon.sock'),
    message: 'the daemon answered the handshake without its build and id',
  });

  expect(read).not.toHaveBeenCalled();
});

test('it returns the refusal of a daemon on another protocol', async () => {
  const ctx = setupTest();

  startStubLegacyDaemon(join(ctx.dir, 'atc-daemon.sock'), { protocol: PROTOCOL_V + 1 });

  const probe = await tryOpenDaemon(
    [join(ctx.dir, 'atc-daemon.sock')],
    { build: 'atc/test-build', deadline: systemClock.now() + 3000, clock: systemClock },
    () => Promise.resolve(null),
  );

  expect(probe).toStrictEqual({
    kind: 'refused',
    socketPath: join(ctx.dir, 'atc-daemon.sock'),
    message: `atc/test-build speaks protocol v${PROTOCOL_V}, daemon atc/legacy-build speaks v${PROTOCOL_V + 1}; restart the daemon so both run the same build`,
  });
});

test('it tries the next socket when one refuses the connection', async () => {
  const ctx = setupTest();

  startStubLegacyDaemon(join(ctx.dir, 'recorded.sock'));

  const probe = await tryOpenDaemon(
    [join(ctx.dir, 'computed.sock'), join(ctx.dir, 'recorded.sock')],
    { build: 'atc/test-build', deadline: systemClock.now() + 3000, clock: systemClock },
    () => Promise.resolve(null),
  );

  expect(probe?.socketPath).toBe(join(ctx.dir, 'recorded.sock'));
});

test('it returns nothing when no socket answers', async () => {
  const ctx = setupTest();

  const probe = await tryOpenDaemon(
    [join(ctx.dir, 'atc-daemon.sock')],
    { build: 'atc/test-build', deadline: systemClock.now() + 3000, clock: systemClock },
    () => Promise.resolve(null),
  );

  expect(probe).toBeNull();
});

test('it gives up on a daemon that never answers once the deadline passes', async () => {
  const ctx = setupTest();
  const clock = buildStubClock(0);

  startStubUnansweringUnixListener(join(ctx.dir, 'atc-daemon.sock'));

  const probing = tryOpenDaemon(
    [join(ctx.dir, 'atc-daemon.sock')],
    { build: 'atc/test-build', deadline: 3000, clock },
    () => Promise.resolve(null),
  );

  const step = await waitFor(() => {
    const [pending] = clock.collectPending();

    if (pending === undefined) {
      throw new Error('no deadline is pending');
    }

    return pending;
  });

  clock.advance(step);

  const probe = await probing;

  expect(probe).toBeNull();
  expect(step).toBe(3000);
});

test('it leaves the next socket time to answer when one never answers', async () => {
  const ctx = setupTest();
  const clock = buildStubClock(0);

  startStubUnansweringUnixListener(join(ctx.dir, 'atc-daemon.sock'));

  startStubLegacyDaemon(join(ctx.dir, 'recorded.sock'), {
    replies: { 'daemon.hello': { daemon: 'atc/1.2.3', daemonID: 'd-1' } },
  });

  const probing = tryOpenDaemon(
    [join(ctx.dir, 'atc-daemon.sock'), join(ctx.dir, 'recorded.sock')],
    { build: 'atc/test-build', deadline: 3000, clock },
    () => Promise.resolve(null),
  );

  const step = await waitFor(() => {
    const [pending] = clock.collectPending();

    if (pending === undefined) {
      throw new Error('no deadline is pending');
    }

    return pending;
  });

  clock.advance(step);

  const probe = await probing;

  expect(step).toBe(1500);

  expect(probe).toStrictEqual({
    kind: 'ok',
    socketPath: join(ctx.dir, 'recorded.sock'),
    hello: { build: 'atc/1.2.3', daemonID: 'd-1' },
    value: null,
  });
});

test('it closes the client once the read settles', async () => {
  const ctx = setupTest();
  const daemon = startStubLegacyDaemon(join(ctx.dir, 'atc-daemon.sock'));

  await tryOpenDaemon(
    [join(ctx.dir, 'atc-daemon.sock')],
    { build: 'atc/test-build', deadline: systemClock.now() + 3000, clock: systemClock },
    () => Promise.resolve(null),
  );

  await waitFor(() => {
    expect(daemon.connections.open).toBe(0);
  });

  expect(daemon.connections.accepted).toBe(1);
});

test('it leaves the client open for a caller that keeps it', async () => {
  const ctx = setupTest();
  const daemon = startStubLegacyDaemon(join(ctx.dir, 'atc-daemon.sock'));

  const probe = await tryOpenDaemon(
    [join(ctx.dir, 'atc-daemon.sock')],
    {
      build: 'atc/test-build',
      deadline: systemClock.now() + 3000,
      clock: systemClock,
      keepOpen: true,
    },
    (client) => Promise.resolve(client),
  );

  invariant(probe?.kind === 'ok');

  const kept = probe.value;

  registerTestCleanup(() => {
    kept.stop();
  });

  const pinged = await kept.sendRequest('daemon.ping');

  expect(pinged).toStrictEqual({});
  expect(daemon.connections.open).toBe(1);
});
