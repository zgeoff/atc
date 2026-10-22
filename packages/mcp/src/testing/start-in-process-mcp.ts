import { openDaemonClient } from '@atc/protocol/client';
import { buildMCPToolCalls, registerTestCleanup } from '@atc/test-utils';
import {
  InMemoryTransport,
  isJSONRPCResponse,
  isJSONRPCResultResponse,
  isSpecType,
} from '@modelcontextprotocol/server';
import type { ClientRequest, JSONRPCResponse, RequestId } from '@modelcontextprotocol/server';
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

// The params a client request of one method takes.
type ClientRequestParams<Method extends ClientRequest['method']> = Extract<
  ClientRequest,
  { method: Method }
>['params'];

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

  const pending = new Map<RequestId, PromiseWithResolvers<JSONRPCResponse>>();

  // the SDK's transport takes its message callback as a property, with no addEventListener
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  client.onmessage = (message) => {
    if (!isJSONRPCResponse(message) || message.id === undefined) {
      return;
    }

    pending.get(message.id)?.resolve(message);
    pending.delete(message.id);
  };

  const stop = registerTestCleanup(async () => {
    await server.close();
    await caller.stop();
  });

  await server.connect(served);
  await client.start();

  let nextID = 0;

  const sendRequest = async <Method extends ClientRequest['method']>(
    method: Method,
    params?: ClientRequestParams<Method>,
  ): Promise<JSONRPCResponse> => {
    nextID += 1;

    const id = nextID;
    const response = Promise.withResolvers<JSONRPCResponse>();

    pending.set(id, response);

    await client.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

    return response.promise;
  };

  const initialized = await sendRequest('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'atc-test', version: '1.0.0' },
  });

  const isInitializeResult = isSpecType.InitializeResult;

  if (!isJSONRPCResultResponse(initialized) || !isInitializeResult(initialized.result)) {
    throw new Error(`the MCP server refused the initialize: ${JSON.stringify(initialized)}`);
  }

  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return { sendRequest, ...buildMCPToolCalls(sendRequest), stop };
}
