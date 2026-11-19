// The service client that `local` mints for each run, with every scope, and the variable of the
// supervisor's environment that holds its secret. `atc mcp --http` and both gateways of the run
// take it.
export const localMCPClient = {
  name: 'verify-local',
  secretEnv: 'ATC_VERIFY_LOCAL_MCP_SECRET',
  scope: 'read message spawn kill',
};

// The variable that carries the digest of the local client's secret to the run's launcher. The
// launcher never gets the secret.
export const localDigestEnv = 'ATC_VERIFY_MCP_DIGEST';

// The read client of the deployed gateway. It holds only the read scope, so the gateway refuses any
// write that the read-only target misses.
export const prodMCPClient = {
  name: 'wringer-ro',
  secretEnv: 'ATC_PROD_MCP_SECRET',
  scope: 'read',
};

// The tools `prod` may call. A session's screen or name can hold anything, so `prod` reads the
// list, one session and one screen, and keeps its evidence local.
export const prodReadTools = ['atc_sessions_list', 'atc_session_get', 'atc_terminal_read'];

// The variable that holds the deployed gateway's origin, its OAuth issuer. The repo is public and
// names no host, so the origin comes from 1Password with the read client's secret.
export const prodOriginEnv = 'ATC_PROD_ORIGIN';

// The gateway's protected-resource metadata, which an MCP client reads before it signs in.
export const resourceMetadataPath = '/.well-known/oauth-protected-resource/mcp';

// The name of the run's daemon in the gateways' registry.
export const gatewayDaemonName = 'verify';

// The token the `docker` target's run stores in its sign-in volume. It is no real token, and no
// container's environment may ever hold it.
export const dockerTokenValue = 'verify-not-a-real-token';
