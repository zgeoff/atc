import { GATEWAY_PATHS } from '@atcx/contract';
import type { MCPAuthPaths, MCPAuthTables } from '@zgeoff/mcp-auth';

// The tables atc's own OAuth server kept its passkeys and enrollment tokens
// in, so the owner's enrolled passkeys stay where they are.
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
