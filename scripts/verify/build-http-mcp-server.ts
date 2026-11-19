interface MCPClientConfig {
  readonly name: string;
  readonly secretEnv: string;
  readonly scope: string;
}

export function buildHTTPMCPServer(
  origin: string,
  client: MCPClientConfig,
  readTools: readonly string[],
) {
  return {
    transport: 'http' as const,
    url: `${origin}/mcp`,
    auth: {
      clientCredentials: {
        clientID: `service:${client.name}`,
        secretEnv: client.secretEnv,
        scope: client.scope,
        issuer: origin,
      },
    },
    readTools: [...readTools],
  };
}
