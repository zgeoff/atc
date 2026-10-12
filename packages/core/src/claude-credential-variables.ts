/**
 * The variables the Claude CLI reads its endpoint and credentials from: the
 * subscription token, a bearer token, an API key, and the API base URL.
 */
export const CLAUDE_CREDENTIAL_VARIABLES = {
  oauthToken: 'CLAUDE_CODE_OAUTH_TOKEN',
  authToken: 'ANTHROPIC_AUTH_TOKEN',
  apiKey: 'ANTHROPIC_API_KEY',
  baseURL: 'ANTHROPIC_BASE_URL',
} as const;
