import { isRecord } from '@atc/core';
import { openDaemonClient } from '@atc/protocol/client';
import { parseMCPToolResult, registerTestCleanup } from '@atc/test-utils';
import type { MCPToolResult } from '@atc/test-utils';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createMCPServer } from '../tools/create-mcp-server';
import { createTransportCaller } from '../tools/create-transport-caller';

interface InProcessMCPConfig {
  // The socket of the daemon the server calls, and the build it greets it as.
  readonly socketPath: string;
  readonly build: string;

  // The session the server runs inside; absent means a server started
  // outside any session.
  readonly callerSessionID?: string;
}

export async function startInProcessMCP(config: InProcessMCPConfig) {
  const callerSessionID = config.callerSessionID ?? null;

  const caller = createTransportCaller(
    config.socketPath,
    config.build,
    (path) => openDaemonClient(path),
    callerSessionID,
  );

  const server = createMCPServer({ caller, build: config.build, toolContext: { callerSessionID } });
  const [client, served] = InMemoryTransport.createLinkedPair();

  const pending = new Map<number, PromiseWithResolvers<Readonly<Record<string, unknown>>>>();

  // the SDK's transport takes its message callback as a property, with no addEventListener
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  client.onmessage = (message) => {
    const received: unknown = message;
    const id = isRecord(received) ? received['id'] : undefined;
    const waiting = typeof id === 'number' ? pending.get(id) : undefined;

    if (isRecord(received) && waiting !== undefined) {
      waiting.resolve(received);
    }
  };

  const stop = registerTestCleanup(async () => {
    await server.close();
    await caller.stop();
  });

  await server.connect(served);
  await client.start();

  let nextID = 0;

  const sendRequest = async (
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> => {
    nextID += 1;

    const id = nextID;
    const response = Promise.withResolvers<Readonly<Record<string, unknown>>>();

    pending.set(id, response);

    await client.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

    return response.promise;
  };

  const sendToolCall = async (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<MCPToolResult> => {
    const response = await sendRequest('tools/call', { name, arguments: args });

    return parseMCPToolResult(response);
  };

  const initialized = await sendRequest('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'atc-test', version: '1.0.0' },
  });

  if (!isRecord(initialized['result'])) {
    throw new Error(`the MCP server refused the initialize: ${JSON.stringify(initialized)}`);
  }

  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    sendRequest,
    sendToolCall,
    async spawnSession(args: Readonly<Record<string, unknown>>): Promise<string> {
      const spawned = await sendToolCall('atc_session_spawn', args);

      const id = spawned.structured?.['id'];

      if (typeof id !== 'string') {
        throw new TypeError(`spawn returned no session id: ${spawned.text}`);
      }

      return id;
    },
    stop,
  };
}
