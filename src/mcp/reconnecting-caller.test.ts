import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupMCPHTTP } from '../../test/setup-mcp-http';
import { setupTempDir } from '../../test/setup-temp-dir';
import { startLegacyDaemon } from '../../test/start-legacy-daemon';
import { waitFor } from '../../test/wait-for';
import { startDaemon } from '../daemon/daemon';
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

  const caller = new ReconnectingCaller(socketPath, 'atc/test-build');

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

  const caller = new ReconnectingCaller(socketPath, 'atc/test-build');

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
