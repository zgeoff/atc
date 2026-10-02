import { match } from 'ts-pattern';
import { DaemonError } from '../protocol/daemon-error';
import { isRecord } from '../shared/report';
import { buildToolList } from './build-tool-list';
import { pickProtocolVersion } from './pick-protocol-version';
import { runTool } from './run-tool';
import type { FleetCaller, ToolContext } from './types';

interface RPCDeps {
  readonly caller: FleetCaller;
  readonly build: string;
  readonly toolContext: ToolContext;
}

type RPCOutcome =
  | { readonly kind: 'reply'; readonly body: Readonly<Record<string, unknown>> }
  | { readonly kind: 'accepted' }
  | { readonly kind: 'invalid' };

export async function answerRPCRequest(message: unknown, deps: RPCDeps): Promise<RPCOutcome> {
  if (!isRecord(message) || typeof message['method'] !== 'string') {
    return { kind: 'invalid' };
  }

  const method = message['method'];
  const id = message['id'];

  // Notifications carry no id and get no response.
  if (id === undefined || id === null) {
    return { kind: 'accepted' };
  }

  if (typeof id !== 'string' && typeof id !== 'number') {
    return { kind: 'invalid' };
  }

  const params = isRecord(message['params']) ? message['params'] : {};

  const outcome = await match(method)
    .with('initialize', () => ({
      kind: 'reply' as const,
      body: buildRPCResult(id, {
        protocolVersion: pickProtocolVersion(params['protocolVersion']),
        capabilities: { tools: {} },
        serverInfo: { name: 'atc', version: deps.build },
      }),
    }))
    .with('ping', () => ({ kind: 'reply' as const, body: buildRPCResult(id, {}) }))
    .with('tools/list', () => ({
      kind: 'reply' as const,
      body: buildRPCResult(id, { tools: buildToolList() }),
    }))
    .with('tools/call', async () => {
      const result = await answerToolCall(deps, params);

      return { kind: 'reply' as const, body: buildRPCResult(id, result) };
    })
    .otherwise(() => ({
      kind: 'reply' as const,
      body: buildRPCError(id, -32_601, `unknown method '${method}'`),
    }));

  return outcome;
}

async function answerToolCall(
  deps: RPCDeps,
  params: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  const name = typeof params['name'] === 'string' ? params['name'] : '';
  const args = isRecord(params['arguments']) ? params['arguments'] : {};

  try {
    const text = await runTool(deps.caller, name, args, deps.toolContext);

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: formatToolError(error) }], isError: true };
  }
}

function formatToolError(error: unknown): string {
  if (error instanceof DaemonError) {
    return `${error.code}: ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function buildRPCResult(
  id: string | number,
  result: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { jsonrpc: '2.0', id, result };
}

function buildRPCError(
  id: string | number,
  code: number,
  message: string,
): Readonly<Record<string, unknown>> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
