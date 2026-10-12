import { isRecord } from '../shared/report';
import { buildSpawnDescriptions } from './build-spawn-descriptions';
import type { RegisteredAgent } from './build-spawn-descriptions';
import { MCP_TOOLS } from './mcp-tools';
import type { FleetFeature } from './types';

interface MCPTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly openWorldHint: boolean;
  };
}

/**
 * The tools `tools/list` returns for a daemon announcing the given
 * features. A tool the daemon cannot serve is left out, and a tool it serves
 * in an older form is listed without the output schema and input properties
 * that form lacks, so a client never sees an option the daemon would ignore.
 * The spawn tool's description and its agent field's description name the
 * registered agents; null leaves them unnamed. No schema depends on which
 * agents the host registers or installs.
 */
export function buildToolList(
  features: ReadonlySet<FleetFeature>,
  agents: readonly RegisteredAgent[] | null,
): readonly MCPTool[] {
  const spawn = buildSpawnDescriptions(agents);

  return MCP_TOOLS.flatMap((tool) => {
    const requires = tool.requires ?? {};

    if (requires.tool !== undefined && !features.has(requires.tool)) {
      return [];
    }

    const gated = buildInputSchema(tool.inputSchema, requires.inputs ?? {}, features);
    const isSpawn = tool.name === 'atc_session_spawn';
    const description = isSpawn ? spawn.tool : tool.description;
    const inputSchema = isSpawn ? buildAgentFieldSchema(gated, spawn.agent) : gated;

    return [
      tool.outputSchema === undefined ||
      (requires.output !== undefined && !features.has(requires.output)) ||
      (requires.outputUnless !== undefined && features.has(requires.outputUnless))
        ? {
            name: tool.name,
            description,
            inputSchema,
            annotations: tool.annotations,
          }
        : {
            name: tool.name,
            description,
            inputSchema,
            outputSchema: tool.outputSchema,
            annotations: tool.annotations,
          },
    ];
  });
}

function buildInputSchema(
  schema: Readonly<Record<string, unknown>>,
  inputs: Readonly<Record<string, FleetFeature>>,
  features: ReadonlySet<FleetFeature>,
): Readonly<Record<string, unknown>> {
  const withheld = Object.entries(inputs).flatMap(([name, feature]) =>
    features.has(feature) ? [] : [name],
  );

  const properties = schema['properties'];

  if (withheld.length === 0 || !isRecord(properties)) {
    return schema;
  }

  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).filter(([name]) => !withheld.includes(name)),
    ),
  };
}

// The input schema with only the agent field's description replaced.
function buildAgentFieldSchema(
  schema: Readonly<Record<string, unknown>>,
  description: string,
): Readonly<Record<string, unknown>> {
  const properties = schema['properties'];
  const agent = isRecord(properties) ? properties['agent'] : undefined;

  if (!isRecord(properties) || !isRecord(agent)) {
    return schema;
  }

  return { ...schema, properties: { ...properties, agent: { ...agent, description } } };
}
