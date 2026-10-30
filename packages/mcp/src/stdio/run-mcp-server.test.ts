import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir, waitFor } from '@atc/test-utils';

test('it serves a remote session through its bridge socket and never boots a daemon', async () => {
  const directory = setupTempDir('atc-mcp-bridge-').path;
  const bridgePath = join(directory, 'bridge.sock');
  const bootMarker = join(directory, 'booted');
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

  const server = Bun.spawn(
    [
      process.execPath,
      '-e',
      `const { runMCPServer } = await import(${JSON.stringify(join(import.meta.dir, 'run-mcp-server.ts'))});
await runMCPServer('atc/test', { kind: 'local', boot: async () => {
  await Bun.write(${JSON.stringify(bootMarker)}, 'booted');
  throw new Error('booted a daemon');
} });`,
    ],
    {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: directory,
        ATC_SESSION_ID: 's-remote',
        ATC_BRIDGE: '1',
        ATC_SOCKET: bridgePath,
      },
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );

  registerTestCleanup(() => {
    server.kill();

    return server.exited;
  });

  await server.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
  );

  await server.stdin.flush();

  await waitFor(() => {
    expect(received.join('')).toInclude('/daemon/hello');
  });

  expect(existsSync(bootMarker)).toBe(false);
});

test('it calls a named daemon through the channels the entry opens, never the bridge socket of its session', async () => {
  const directory = setupTempDir('atc-mcp-named-').path;
  const bridgePath = join(directory, 'bridge.sock');
  const openMarker = join(directory, 'opened');
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

  const server = Bun.spawn(
    [
      process.execPath,
      '-e',
      `const { runMCPServer } = await import(${JSON.stringify(join(import.meta.dir, 'run-mcp-server.ts'))});
const { createChannelCaller } = await import(${JSON.stringify(join(import.meta.dir, '..', 'tools', 'create-channel-caller.ts'))});
await runMCPServer('atc/test', { kind: 'named', caller: createChannelCaller(async () => {
  await Bun.write(${JSON.stringify(openMarker)}, 'opened');
  throw new Error('the named daemon is down');
}) });`,
    ],
    {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: directory,
        ATC_SESSION_ID: 's-remote',
        ATC_BRIDGE: '1',
        ATC_SOCKET: bridgePath,
      },
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );

  registerTestCleanup(() => {
    server.kill();

    return server.exited;
  });

  await server.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
  );

  await server.stdin.flush();

  await waitFor(() => {
    expect(existsSync(openMarker)).toBe(true);
  });

  expect(received).toStrictEqual([]);
});
