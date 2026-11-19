import { parseMCPToolResult } from './parse-mcp-tool-result';
import type { MCPToolResult } from './parse-mcp-tool-result';

interface ToolsCallParams {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

// Sends one `tools/call` request and resolves with its response.
type SendToolsCall = (
  method: 'tools/call',
  params: ToolsCallParams,
) => Promise<Readonly<Record<string, unknown>>>;

interface MCPToolCalls {
  readonly sendToolCall: (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<MCPToolResult>;

  // Spawns a session through the spawn tool and resolves with its id.
  readonly spawnSession: (args: Readonly<Record<string, unknown>>) => Promise<string>;
}

export function buildMCPToolCalls(sendRequest: SendToolsCall): MCPToolCalls {
  const sendToolCall = async (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<MCPToolResult> => {
    const response = await sendRequest('tools/call', { name, arguments: args });

    return parseMCPToolResult(response);
  };

  return {
    sendToolCall,
    spawnSession: async (args) => {
      const spawned = await sendToolCall('atc_session_spawn', args);

      const id = spawned.structured?.['id'];

      if (typeof id !== 'string') {
        throw new TypeError(`spawn returned no session id: ${spawned.text}`);
      }

      return id;
    },
  };
}
