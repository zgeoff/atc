import { GATEWAY_PATHS } from '@atcx/contract';
import type { MCPAuthPaths, MCPAuthTables } from '@zgeoff/mcp-auth';

// These names match the existing tables that hold the owner's enrolled passkeys and
// enrollment tokens, so changing them would orphan those passkeys.
export const ATC_AUTH_TABLES: MCPAuthTables = {
  passkey: 'atc_passkey',
  enrollmentToken: 'atc_enrollment_token',
};

export const ATC_AUTH_PATHS: MCPAuthPaths = {
  browser: GATEWAY_PATHS.browser,
  machine: GATEWAY_PATHS.machine,
};

// Every service token starts with this, so a bearer is routed to the token
// file or to the authorization server's database by its first characters.
export const SERVICE_TOKEN_PREFIX = 'atcs_';
