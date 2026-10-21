import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import { registerTestCleanup, setupTempDir, waitFor } from '@atc/test-utils';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createMCPServer } from './create-mcp-server';
import { TransportCaller } from './transport-caller';
import type { FleetCaller } from './types';

// The server on one end of an in-memory pair, initialized, with every message
// it sends back recorded.
async function setupTest(caller: FleetCaller) {
  const server = createMCPServer({
    caller,
    build: 'atc/test-build',
    toolContext: { callerSessionID: null },
  });

  const [client, served] = InMemoryTransport.createLinkedPair();
  const answers: unknown[] = [];

  // the SDK's transport takes its message callback as a property, with no addEventListener
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  client.onmessage = (message) => {
    answers.push(message);
  };

  await server.connect(served);
  await client.start();

  registerTestCleanup(() => server.close());

  await client.send({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'atc-test', version: '1.0.0' },
    },
  });

  return { client, answers };
}

test('it answers a tool list with an error when no daemon listens on the socket', async () => {
  const temporaryDirectory = setupTempDir('atc-create-mcp-server-');

  const caller = new TransportCaller(
    join(temporaryDirectory.path, 'daemon.sock'),
    'atc/test-build',
    (path) => openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const ctx = await setupTest(caller);

  await ctx.client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  await waitFor(() => {
    expect(ctx.answers).toPartiallyContain({ id: 1 });
  });

  expect(ctx.answers).toPartiallyContain({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32_603, message: expect.toBeString() },
  });
});
