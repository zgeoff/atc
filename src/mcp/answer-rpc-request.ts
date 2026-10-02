import { match } from 'ts-pattern';
import { z } from 'zod';
import { DaemonError } from '../protocol/daemon-error';
import type { GrantScope } from '../shared/grant-scope';
import { isRecord } from '../shared/report';
import type { RegisteredAgent } from './build-spawn-descriptions';
import { buildToolList } from './build-tool-list';
import { MCP_TOOLS } from './mcp-tools';
import { pickProtocolVersion } from './pick-protocol-version';
import { runTool } from './run-tool';
import type { FleetCaller, ToolContext } from './types';

interface RPCDeps {
  readonly caller: FleetCaller;
  readonly build: string;
  readonly toolContext: ToolContext;

  // The scopes the caller holds; absent means every tool is allowed.
  readonly scopes?: readonly GrantScope[];
}

type RPCOutcome =
  | { readonly kind: 'reply'; readonly body: Readonly<Record<string, unknown>> }
  | { readonly kind: 'accepted' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'forbidden'; readonly scope: GrantScope };

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
  const missingScope = method === 'tools/call' ? findMissingScope(params, deps.scopes) : null;

  if (missingScope !== null) {
    return { kind: 'forbidden', scope: missingScope };
  }

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
    .with('tools/list', async () => {
      const features = await deps.caller.readFeatures();
      const agents = features.has('agents.list') ? await tryReadAgents(deps.caller) : null;

      return {
        kind: 'reply' as const,
        body: buildRPCResult(id, { tools: buildToolList(features, agents) }),
      };
    })
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

const STRICTEST_SCOPE: GrantScope = 'kill';

// The scope a tool call needs and the caller lacks. A tool with no listed
// scope fails closed: it needs the strictest scope, and only a caller holding
// that one gets the unknown name back as a tool error.
function findMissingScope(
  params: Readonly<Record<string, unknown>>,
  scopes: readonly GrantScope[] | undefined,
): GrantScope | null {
  if (scopes === undefined) {
    return null;
  }

  const tool = MCP_TOOLS.find((candidate) => candidate.name === params['name']);
  const needed = tool === undefined ? STRICTEST_SCOPE : tool.scope;

  return scopes.includes(needed) ? null : needed;
}

// The part of an agents.list answer the spawn descriptions read.
const ROSTER_AGENT_SCHEMA = z.object({ id: z.string(), installed: z.boolean() });
const AGENT_ROSTER_SCHEMA = z.object({ agents: z.array(ROSTER_AGENT_SCHEMA) });

// The registered agents, or null when the daemon cannot answer, so the tool
// list still builds with descriptions that name no agent.
async function tryReadAgents(caller: FleetCaller): Promise<RegisteredAgent[] | null> {
  try {
    const answer = await caller.sendRequest('agents.list');

    const parsed = AGENT_ROSTER_SCHEMA.safeParse(answer);

    return parsed.success ? parsed.data.agents : null;
  } catch {
    return null;
  }
}

async function answerToolCall(
  deps: RPCDeps,
  params: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  const name = typeof params['name'] === 'string' ? params['name'] : '';
  const args = isRecord(params['arguments']) ? params['arguments'] : {};

  try {
    const result = await runTool(deps.caller, name, args, deps.toolContext);

    return {
      content: [{ type: 'text', text: result.text }],
      ...(result.structured === null ? {} : { structuredContent: result.structured }),
    };
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
