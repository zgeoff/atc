import { BROKER_PLACEHOLDER } from '@atc/core';
import type { GuestFile } from '@atc/plugin-api';

// Claude Code strips the placeholder variable from every tool it runs, so a CLI a tool starts,
// such as a `claude -p` judge, signs in from this file; with no refresh token or expiry the
// CLI never tries to refresh it
export function buildClaudeCredentialsFile(): GuestFile {
  const credentials = {
    claudeAiOauth: {
      accessToken: BROKER_PLACEHOLDER,
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
    },
  };

  return {
    content: new TextEncoder().encode(`${JSON.stringify(credentials, null, 2)}\n`),
    mode: 0o600,
  };
}
