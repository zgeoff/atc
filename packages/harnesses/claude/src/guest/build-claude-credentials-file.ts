import { BROKER_PLACEHOLDER } from '@atc/core/broker-placeholder';
import type { GuestFile } from '@atc/plugin-api/agent-adapter';

/**
 * The `.credentials.json` of a session's own Claude config folder, which
 * holds no credential: its access token is the placeholder that impd's
 * broker swaps for the subscription token on each request to the Claude
 * API. The session's CLI signs in from the placeholder variable it starts
 * with, but Claude Code removes that variable from every tool it runs, and
 * a CLI started with no setting sources reads no settings `env`. A Claude
 * CLI that a tool starts, such as a `claude -p` judge, therefore signs in
 * from this file. The token carries no refresh token and no expiry, so the
 * CLI never tries to refresh it, and its one scope is inference, the scope
 * of a setup token. Only the owner may read the file, as with a real one.
 */
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
