// The routes of the HTTP server that atc-gateway and `atc mcp --http` run. A
// person opens the browser routes in a browser, so an ingress may put them
// behind a sign-in that a machine client could not pass.
export const GATEWAY_PATHS = {
  browser: {
    authorize: '/oauth2/authorize',
    login: '/login',
    enroll: '/enroll',
    consent: '/consent',
    error: '/error',
  },
  machine: {
    mcp: '/mcp',

    // MCP answers at the bare origin as well, for a client configured with it
    // and no path.
    root: '/',
    token: '/oauth2/token',
    revoke: '/oauth2/revoke',
    authorizationServerMetadata: '/.well-known/oauth-authorization-server',
    resourceMetadata: '/.well-known/oauth-protected-resource',
    mcpResourceMetadata: '/.well-known/oauth-protected-resource/mcp',
  },

  // served only to an orchestrator's probes, never through an ingress
  probes: {
    health: '/healthz',
    ready: '/readyz',
  },
} as const;
