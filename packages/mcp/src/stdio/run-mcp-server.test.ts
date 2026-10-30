import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir, updateEnv, waitFor } from '@atc/test-utils';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { createChannelCaller } from '../tools/create-channel-caller';
import { runMCPServer } from './run-mcp-server';

async function setupTest() {
  const [client, served] = InMemoryTransport.createLinkedPair();
  const received: JSONRPCMessage[] = [];

  // the SDK's transport takes its message callback as a property, with no addEventListener
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  client.onmessage = (message) => {
    received.push(message);
  };

  await client.start();

  registerTestCleanup(() => client.close());

  return { client, served, received };
}

test('it answers initialize before it boots a daemon, and boots one for the first tool list', async () => {
  const ctx = await setupTest();

  const boot = mock(() => Promise.reject(new Error('no daemon answers')));
  const running = runMCPServer('atc/test', { kind: 'local', boot }, ctx.served);

  registerTestCleanup(async () => {
    await ctx.client.close();

    await running;
  });

  await ctx.client.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    },
  });

  await waitFor(() => {
    expect(ctx.received).toContainEqual(
      expect.objectContaining({ id: 1, result: expect.anything() }),
    );
  });

  const bootsAtInitialize = boot.mock.calls.length;

  await ctx.client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await ctx.client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

  const refusal = expect.objectContaining({ message: expect.toInclude('no daemon answers') });

  await waitFor(() => {
    expect(ctx.received).toContainEqual(expect.objectContaining({ id: 2, error: refusal }));
  });

  expect(bootsAtInitialize).toBe(0);
  expect(boot).toHaveBeenCalledOnce();
});

test('it serves a remote session through its bridge socket and never boots a daemon', async () => {
  const ctx = await setupTest();

  const bridgePath = join(setupTempDir('atc-mcp-bridge-').path, 'bridge.sock');
  const received: string[] = [];

  const bridge = Bun.listen({
    unix: bridgePath,
    socket: {
      data: (_socket, buf) => {
        received.push(new TextDecoder().decode(buf));
      },
    },
  });

  registerTestCleanup(() => {
    bridge.stop(true);
  });

  updateEnv('ATC_SESSION_ID', 's-remote');
  updateEnv('ATC_BRIDGE', '1');
  updateEnv('ATC_SOCKET', bridgePath);

  const boot = mock(() => Promise.reject(new Error('booted a daemon')));
  const running = runMCPServer('atc/test', { kind: 'local', boot }, ctx.served);

  registerTestCleanup(async () => {
    await ctx.client.close();

    await running;
  });

  await ctx.client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  await waitFor(() => {
    expect(received.join('')).toInclude('/daemon/hello');
  });

  expect(boot).not.toHaveBeenCalled();
});

test('it calls a named daemon through the channels the entry opens, never the bridge socket of its session', async () => {
  const ctx = await setupTest();

  const bridgePath = join(setupTempDir('atc-mcp-named-').path, 'bridge.sock');
  const received: string[] = [];

  const bridge = Bun.listen({
    unix: bridgePath,
    socket: {
      data: (_socket, buf) => {
        received.push(new TextDecoder().decode(buf));
      },
    },
  });

  registerTestCleanup(() => {
    bridge.stop(true);
  });

  updateEnv('ATC_SESSION_ID', 's-remote');
  updateEnv('ATC_BRIDGE', '1');
  updateEnv('ATC_SOCKET', bridgePath);

  const open = mock(() => Promise.reject(new Error('the named daemon is down')));

  const running = runMCPServer(
    'atc/test',
    { kind: 'named', caller: createChannelCaller(open) },
    ctx.served,
  );

  registerTestCleanup(async () => {
    await ctx.client.close();

    await running;
  });

  await ctx.client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  await waitFor(() => {
    expect(ctx.received).toContainEqual(expect.objectContaining({ id: 1 }));
  });

  expect(open).toHaveBeenCalledOnce();
  expect(received).toStrictEqual([]);
});
