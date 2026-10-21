import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { isRecord } from '@atc/core';
import { openDaemonClient } from '@atc/protocol/client';
import { getRecord, registerTestCleanup, setupTempDir, waitFor } from '@atc/test-utils';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import invariant from 'tiny-invariant';
import { buildStubFleetCaller } from '../testing/build-stub-fleet-caller';
import { createMCPServer } from './create-mcp-server';
import { createTransportCaller } from './create-transport-caller';
import type { GrantScope } from './grant-scope';
import type { FleetCaller } from './types';

// The server on one end of an in-memory pair, initialized, with every message
// it sends back recorded; absent scopes allow every tool.
async function setupTest(caller: FleetCaller, scopes?: readonly GrantScope[]) {
  const server = createMCPServer({
    caller,
    build: 'atc/test-build',
    toolContext: { callerSessionID: null },
    ...(scopes === undefined ? {} : { scopes }),
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

  const caller = createTransportCaller(
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

test('it refuses a tool call with an argument its schema does not list before it reaches the daemon', async () => {
  const caller = buildStubFleetCaller();

  const ctx = await setupTest(caller);

  await ctx.client.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'atc_message_send',
      arguments: { session: 's1', text: 'hello', from: 'someone-else' },
    },
  });

  await waitFor(() => {
    expect(ctx.answers).toPartiallyContain({ id: 1 });
  });

  expect(ctx.answers).toPartiallyContain({
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [
        {
          type: 'text',
          text: 'Input validation error: Invalid arguments for tool atc_message_send: data must NOT have additional properties',
        },
      ],
      isError: true,
    },
  });

  expect(caller.requests).toStrictEqual([]);
});

test('it lists a tool outside the one scope a caller holds', async () => {
  const ctx = await setupTest(buildStubFleetCaller(), ['read']);

  await ctx.client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  await waitFor(() => {
    expect(ctx.answers).toPartiallyContain({ id: 1 });
  });

  expect(ctx.answers).toPartiallyContain({
    id: 1,
    result: {
      tools: expect.arrayContaining([expect.objectContaining({ name: 'atc_session_stop' })]),
    },
  });
});

test('it names the registered agents in the spawn tool to a caller holding the read scope', async () => {
  const caller = buildStubFleetCaller({
    answer: () => ({ agents: [{ id: 'claude', installed: true }] }),
  });

  const ctx = await setupTest(caller, ['read', 'spawn']);

  await ctx.client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  await waitFor(() => {
    expect(ctx.answers).toPartiallyContain({ id: 1 });
  });

  const listed = ctx.answers.find((answer) => isRecord(answer) && answer['id'] === 1);

  invariant(isRecord(listed));

  const tools = getRecord(listed, 'result')['tools'];

  invariant(Array.isArray(tools));

  const spawn: unknown = tools.find(
    (tool) => isRecord(tool) && tool['name'] === 'atc_session_spawn',
  );

  expect(caller.requests).toStrictEqual([{ method: 'agents.list' }]);

  expect(spawn).toMatchObject({
    inputSchema: {
      properties: {
        agent: { description: expect.stringContaining('the host registered: claude.') },
      },
    },
  });
});

test('it reads no agents for a caller without the read scope', async () => {
  const caller = buildStubFleetCaller({
    answer: () => ({ agents: [{ id: 'claude', installed: true }] }),
  });

  const ctx = await setupTest(caller, ['spawn']);

  await ctx.client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  await waitFor(() => {
    expect(ctx.answers).toPartiallyContain({ id: 1 });
  });

  expect(caller.requests).toStrictEqual([]);
});
