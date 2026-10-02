import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupMCPHTTP } from '../../test/setup-mcp-http';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { PROTOCOL_V, decodeMessage, encodeMessage } from '../protocol/protocol';
import { ReconnectingCaller } from './reconnecting-caller';

test('it answers a read-only request sent right after the daemon restarts', async () => {
  await using mcp = await setupMCPHTTP();

  const before = await mcp.caller.sendRequest('grant.list');

  await mcp.restartDaemon();

  const after = mcp.caller.sendRequest('grant.verify', {
    accessHash: 'unknown',
    resource: `${mcp.origin}/mcp`,
  });

  expect(before).toStrictEqual({ grants: [] });
  expect(after).rejects.toMatchObject({ code: 'unauthorized' });
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

  const first = caller.sendRequest('grant.list');

  expect(first).rejects.toMatchObject({ code: 'protocol_mismatch' });

  await first.catch(() => null);

  await waitFor(() => {
    expect(sockets.open).toBe(0);
  });

  const second = caller.sendRequest('grant.list');

  expect(second).rejects.toMatchObject({ code: 'protocol_mismatch' });

  await second.catch(() => null);

  expect(sockets.accepted).toBe(2);
});

test('it keeps a connection opened while the one before it was closing', async () => {
  await using mcp = await setupMCPHTTP();

  await mcp.caller.sendRequest('grant.list');

  const stopping = mcp.caller.stop();
  const opening = mcp.caller.sendRequest('grant.list');

  await stopping;
  await opening;

  await mcp.caller.sendRequest('grant.list');

  await waitFor(() => {
    expect(mcp.countDaemonClients()).toBe(1);
  });
});
