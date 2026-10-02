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

export function buildToolList(): readonly MCPTool[] {
  return MCP_TOOLS.map((tool) =>
    tool.outputSchema === undefined
      ? {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        }
      : {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: tool.annotations,
        },
  );
}
