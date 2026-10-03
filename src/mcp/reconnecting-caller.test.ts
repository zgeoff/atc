import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupMCPHTTP } from '../../test/setup-mcp-http';
import { setupTempDir } from '../../test/setup-temp-dir';
import { startLegacyDaemon } from '../../test/start-legacy-daemon';
import { waitFor } from '../../test/wait-for';
import { DaemonClient } from '../client/daemon-client';
import { startDaemon } from '../daemon/daemon';
import type { DaemonFeature } from '../protocol/daemon-features';
import { PROTOCOL_V, decodeMessage, encodeMessage } from '../protocol/protocol';
import { ReconnectingCaller } from './reconnecting-caller';

test('it answers a read-only request sent right after the daemon restarts', async () => {
  await using mcp = await setupMCPHTTP();

  const before = await mcp.caller.sendRequest('session.list');

  await mcp.restartDaemon();

  const after = await mcp.caller.sendRequest('session.list');

  expect(before).toStrictEqual({ sessions: [] });
  expect(after).toStrictEqual({ sessions: [] });
});

test('it closes a connection whose handshake the daemon rejects and reconnects on the next request', async () => {
  const tmp = setupTempDir('atc-reconnecting-caller-');
  const socketPath = join(tmp.dir, 'daemon.sock');
  const sockets = { accepted: 0, open: 0 };

  // A daemon speaking another protocol version: it answers every request
  // with protocol_mismatch and leaves the connection for the client to end.
  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open() {
        sockets.accepted += 1;
        sockets.open += 1;
      },
      data(socket, buf) {
        for (const line of buf.toString().split('\n')) {
          const decoded = decodeMessage(line);

          if (decoded.kind === 'request') {
            socket.write(
              encodeMessage({
                v: PROTOCOL_V,
                id: decoded.msg.id,
                err: { code: 'protocol_mismatch', msg: 'the daemon speaks another protocol' },
              }),
            );
          }
        }
      },
      close() {
        sockets.open -= 1;
      },
    },
  });

  const caller = new ReconnectingCaller(socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(async () => {
    await caller.stop();

    server.stop(true);
    tmp[Symbol.dispose]();
  });

  const first = caller.sendRequest('session.list');

  expect(first).rejects.toMatchObject({ code: 'protocol_mismatch' });

  await first.catch(() => null);

  await waitFor(() => {
    expect(sockets.open).toBe(0);
  });

  const second = caller.sendRequest('session.list');

  expect(second).rejects.toMatchObject({ code: 'protocol_mismatch' });

  await second.catch(() => null);

  expect(sockets.accepted).toBe(2);
});

test('it keeps a connection opened while the one before it was closing', async () => {
  await using mcp = await setupMCPHTTP();

  await mcp.caller.sendRequest('session.list');

  const stopping = mcp.caller.stop();
  const opening = mcp.caller.sendRequest('session.list');

  await stopping;
  await opening;

  await mcp.caller.sendRequest('session.list');

  await waitFor(() => {
    expect(mcp.countDaemonClients()).toBe(1);
  });
});

test('it refuses a filtered read unsent when an older daemon replaced the one it handshook with', async () => {
  using tmp = setupTempDir('atc-reconnecting-caller-');

  const socketPath = join(tmp.dir, 'daemon.sock');

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
  });

  const caller = new ReconnectingCaller(socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(async () => {
    await caller.stop();
  });

  const features = await caller.readFeatures();

  await daemon.stop();

  const legacy = startLegacyDaemon(socketPath);

  onTestFinished(() => {
    legacy.stop();
  });

  const read = caller.sendRequest('events.read', { session: 's-1' }, ['events.session']);

  expect([...features]).toContain('events.session');
  expect(read).rejects.toThrow(/^daemon_outdated: /);

  await read.catch(() => null);

  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it retries a spawn on a fresh connection under the key it minted when the connection drops', async () => {
  const daemon = setupDroppingDaemon(['spawn.idempotency']);

  const caller = new ReconnectingCaller(daemon.socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(async () => {
    await caller.stop();
  });

  const ok = await caller.sendRequest('session.spawn', { cwd: '/tmp' });

  expect(ok).toStrictEqual({ session: { id: 's-1' } });
  expect(daemon.keys).toStrictEqual([expect.any(String), daemon.keys[0]]);
});

test('it retries a message on a fresh connection under the key its caller passed', async () => {
  const daemon = setupDroppingDaemon(['message.idempotency']);

  const caller = new ReconnectingCaller(daemon.socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(async () => {
    await caller.stop();
  });

  await caller.sendRequest('session.message', {
    session: 's-1',
    text: 'hi',
    idempotencyKey: 'k-1',
  });

  expect(daemon.keys).toStrictEqual(['k-1', 'k-1']);
});

test('it refuses to retry a keyed spawn unsent when the daemon behind the socket stopped taking keys', async () => {
  const daemon = setupDroppingDaemon(['spawn.idempotency'], []);

  const caller = new ReconnectingCaller(daemon.socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(async () => {
    await caller.stop();
  });

  const spawn = caller.sendRequest('session.spawn', { cwd: '/tmp' });

  expect(spawn).rejects.toThrow(/^daemon_outdated: /);

  await spawn.catch(() => null);

  expect(daemon.keys).toHaveLength(1);
});

test('it fails a spawn whose connection drops when the daemon takes no keys', async () => {
  const daemon = setupDroppingDaemon([]);

  const caller = new ReconnectingCaller(daemon.socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(async () => {
    await caller.stop();
  });

  const spawn = caller.sendRequest('session.spawn', { cwd: '/tmp' });

  expect(spawn).rejects.toThrow();

  await spawn.catch(() => null);

  expect(daemon.keys).toStrictEqual([undefined]);
});

// A daemon that announces the given features, drops the connection of the
// first effectful request before answering it, and answers the next one. A
// reconnect's handshake announces the retry features instead. It records the
// idempotency key each effectful request carried.
function setupDroppingDaemon(
  features: readonly DaemonFeature[],
  retryFeatures: readonly DaemonFeature[] = features,
) {
  const tmp = setupTempDir('atc-reconnecting-caller-');
  const socketPath = join(tmp.dir, 'daemon.sock');
  const keys: unknown[] = [];
  let hellos = 0;

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data(socket, buf) {
        for (const line of buf.toString().split('\n')) {
          const decoded = decodeMessage(line);

          if (decoded.kind !== 'request') {
            continue;
          }

          if (decoded.msg.m === 'daemon.hello') {
            hellos += 1;

            const announced = hellos === 1 ? features : retryFeatures;

            socket.write(
              encodeMessage({ v: PROTOCOL_V, id: decoded.msg.id, ok: { features: announced } }),
            );

            continue;
          }

          keys.push(decoded.msg.p?.['idempotencyKey']);

          if (keys.length === 1) {
            socket.end();
            continue;
          }

          socket.write(
            encodeMessage({ v: PROTOCOL_V, id: decoded.msg.id, ok: { session: { id: 's-1' } } }),
          );
        }
      },
    },
  });

  onTestFinished(() => {
    server.stop(true);
    tmp[Symbol.dispose]();
  });

  return { socketPath, keys };
}
