import type { DaemonFeature } from '../protocol/daemon-features';
import { isRecord } from '../shared/report';
import { MCP_TOOLS } from './mcp-tools';

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
 */
export function buildToolList(features: ReadonlySet<DaemonFeature>): readonly MCPTool[] {
  return MCP_TOOLS.flatMap((tool) => {
    const requires = tool.requires ?? {};

    if (requires.tool !== undefined && !features.has(requires.tool)) {
      return [];
    }

    const inputSchema = buildInputSchema(tool.inputSchema, requires.inputs ?? {}, features);

    return [
      tool.outputSchema === undefined ||
      (requires.output !== undefined && !features.has(requires.output))
        ? {
            name: tool.name,
            description: tool.description,
            inputSchema,
            annotations: tool.annotations,
          }
        : {
            name: tool.name,
            description: tool.description,
            inputSchema,
            outputSchema: tool.outputSchema,
            annotations: tool.annotations,
          },
    ];
  });
}

function buildInputSchema(
  schema: Readonly<Record<string, unknown>>,
  inputs: Readonly<Record<string, DaemonFeature>>,
  features: ReadonlySet<DaemonFeature>,
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
