// The JSON-RPC method and tool name of an MCP request, for its request line.
export interface RPCLabel {
  readonly method: string;
  readonly tool: string | null;
}
