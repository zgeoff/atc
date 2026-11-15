interface MCPClientConfig {
  readonly name: string;
  readonly secretEnv: string;
  readonly scope: string;
}

// One HTTP server of the mcp driver: the `/mcp` at `origin`, signed in through the
// client_credentials grant as `client`, whose secret the driver reads from `client.secretEnv`.
// The credentials go only to the authorization server at `origin`.
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
