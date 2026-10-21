import { isRecord } from '@atc/core';
import { McpServer, fromJsonSchema, isSpecType } from '@modelcontextprotocol/server';
import type {
  CallToolResult,
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from '@modelcontextprotocol/server';
import { Ajv, AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import invariant from 'tiny-invariant';
import { z } from 'zod';
import type { RegisteredAgent } from './build-spawn-descriptions';
import { buildToolList } from './build-tool-list';
import { formatToolError } from './format-tool-error';
import type { GrantScope } from './grant-scope';
import { MCP_TOOLS } from './mcp-tools';
import { runTool } from './run-tool';
import type { FleetCaller, ToolContext } from './types';

interface MCPServerDeps {
  readonly caller: FleetCaller;
  readonly build: string;
  readonly toolContext: ToolContext;

  // The scopes the caller holds; absent means every tool is allowed.
  readonly scopes?: readonly GrantScope[];
}

const isListToolsResult = isSpecType.ListToolsResult;

// zod writes a string's prefix rule as a `starts_with` format beside the
// pattern that checks it, and Ajv warns on every format it does not know.
const ajv = new Ajv({
  strict: false,
  validateFormats: true,
  validateSchema: false,
  allErrors: true,
  formats: { starts_with: true },
});

const ajvValidator = new AjvJsonSchemaValidator(ajv);

// Ajv keeps every schema object it compiles, and each HTTP request builds its
// tools afresh, so each schema text maps to the one object Ajv compiles.
const canonicalSchemas = new Map<string, JsonSchemaType>();

// The SDK compiles a tool's schemas when the tool registers, which costs
// every tool on each start, so each schema compiles on its first call instead.
const schemaValidator: jsonSchemaValidator = {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    let compiled: JsonSchemaValidator<T> | null = null;

    return (input) => {
      if (compiled === null) {
        const text = JSON.stringify(schema);
        const canonical = canonicalSchemas.get(text) ?? schema;

        canonicalSchemas.set(text, canonical);

        compiled = ajvValidator.getValidator<T>(canonical);
      }

      return compiled(input);
    };
  },
};

export function createMCPServer(deps: MCPServerDeps): McpServer {
  const server = new McpServer(
    { name: 'atc', version: deps.build },
    { capabilities: { tools: { listChanged: false } } },
  );

  for (const tool of buildToolList(deps.caller.features, null)) {
    const scope = MCP_TOOLS.find((candidate) => candidate.name === tool.name)?.scope;

    invariant(scope, `the tool table holds no scope for ${tool.name}`);

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema, schemaValidator),
        ...(tool.outputSchema === undefined
          ? {}
          : { outputSchema: fromJsonSchema(tool.outputSchema, schemaValidator) }),
        annotations: tool.annotations,
        scopeChallenge: () =>
          deps.scopes === undefined || deps.scopes.includes(scope)
            ? undefined
            : { scopes: [scope] },
      },
      (args: unknown) => answerToolCall(deps, tool.name, args),
    );
  }

  // McpServer lists each tool with the description it registered, and the
  // spawn tool's description names the agents the daemon has when the list
  // is asked for.
  server.server.setRequestHandler('tools/list', async () => {
    const agents = await tryReadAgents(deps);

    const result = { tools: buildToolList(deps.caller.features, agents) };

    invariant(isListToolsResult(result), 'the tool table builds a list outside MCP');

    return result;
  });

  return server;
}

async function answerToolCall(
  deps: MCPServerDeps,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  const input = isRecord(args) ? args : {};

  try {
    const result = await runTool(deps.caller, name, input, deps.toolContext);

    return {
      content: [{ type: 'text', text: result.text }],
      ...(result.structured === null ? {} : { structuredContent: result.structured }),
    };
  } catch (error) {
    return { content: [{ type: 'text', text: formatToolError(error) }], isError: true };
  }
}

// The part of an agents.list answer the spawn descriptions read.
const ROSTER_AGENT_SCHEMA = z.object({ id: z.string(), installed: z.boolean() });
const AGENT_ROSTER_SCHEMA = z.object({ agents: z.array(ROSTER_AGENT_SCHEMA) });

// The registered agents, or null when the daemon cannot answer, so the tool
// list still builds with descriptions that name no agent. A caller without
// the read scope gets null too, since listing agents is a read.
async function tryReadAgents(deps: MCPServerDeps): Promise<RegisteredAgent[] | null> {
  if (deps.scopes !== undefined && !deps.scopes.includes('read')) {
    return null;
  }

  try {
    const answer = await deps.caller.sendRequest('agents.list');

    const parsed = AGENT_ROSTER_SCHEMA.safeParse(answer);

    return parsed.success ? parsed.data.agents : null;
  } catch {
    return null;
  }
}
