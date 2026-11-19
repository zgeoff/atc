export const localMCPClient = {
  name: 'verify-local',
  secretEnv: 'ATC_VERIFY_LOCAL_MCP_SECRET',
  scope: 'read message spawn kill',
};

export const localDigestEnv = 'ATC_VERIFY_MCP_DIGEST';

// The client holds only the read scope, so the gateway refuses any write.
export const prodMCPClient = {
  name: 'wringer-ro',
  secretEnv: 'ATC_PROD_MCP_SECRET',
  scope: 'read',
};

// A session's screen or name can hold anything, so `prod` keeps its evidence local.
export const prodReadTools = ['atc_sessions_list', 'atc_session_get', 'atc_terminal_read'];

// The repo is public and names no host, so the origin comes from 1Password with the read client's secret.
export const prodOriginEnv = 'ATC_PROD_ORIGIN';
export const resourceMetadataPath = '/.well-known/oauth-protected-resource/mcp';
export const gatewayDaemonName = 'verify';
export const dockerTokenValue = 'verify-not-a-real-token';
