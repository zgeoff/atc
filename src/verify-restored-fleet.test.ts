import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from './client/daemon-client';
import { LineDecoder } from './protocol/line-decoder';
import { PROTOCOL_V, decodeMessage, encodeMessage } from './protocol/protocol';
import { setupTempDir } from './test-utils/setup-temp-dir';
import { verifyRestoredFleet } from './verify-restored-fleet';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-verify-restored-fleet-'));
  const socketPath = join(tmp.dir, 'daemon.sock');
  const lists: Readonly<Record<string, unknown>>[] = [];

  const lines = new LineDecoder();

  // A daemon on the real wire format that accepts the restore and answers one
  // session list for each reply the test queues, then withholds every answer.
  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data(socket, buf) {
        for (const line of lines.splitChunk(buf)) {
          const decoded = decodeMessage(line);

          if (decoded.kind !== 'request') {
            continue;
          }

          const ok = decoded.msg.m === 'fleet.restore' ? {} : lists.shift();

          if (ok !== undefined) {
            socket.write(encodeMessage({ v: PROTOCOL_V, id: decoded.msg.id, ok }));
          }
        }
      },
    },
  });

  stack.defer(() => {
    server.stop(true);
  });

  const client = await DaemonClient.open(socketPath);

  stack.defer(() => {
    client.stop();
  });

  const owned = stack.move();

  return { client, lists, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it reports the last answered list when the deadline overtakes a later list', async () => {
  await using ctx = await setupTest();

  ctx.lists.push({
    sessions: [
      { id: 's-good', kind: 'pty', alive: true, state: 'running', lastMsg: null },
      { id: 's-dropped', kind: 'stub', alive: false, state: 'running', lastMsg: 'no adapter' },
    ],
  });

  // The deadline leaves room for two socket round trips on a loaded machine.
  const verdict = await verifyRestoredFleet(ctx.client, 1, [
    { id: 's-good', name: 'good', exited: false, agentSessionID: null },
    { id: 's-dropped', name: 'dropped', exited: false, agentSessionID: null },
  ]);

  expect(verdict).toStrictEqual({
    total: 2,
    failed: [
      {
        name: 'dropped',
        id: 's-dropped',
        reason: 'listed in state running without a terminal: no adapter',
      },
    ],
  });
});

test('it rejects when the first list gets no answer before the deadline', async () => {
  await using ctx = await setupTest();

  const verdict = verifyRestoredFleet(ctx.client, 0.05, [
    { id: 's-good', name: 'good', exited: false, agentSessionID: null },
  ]);

  expect(verdict).rejects.toThrowWithMessage(
    Error,
    'the new daemon stopped answering before the restore deadline',
  );
});
