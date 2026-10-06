/**
 * The variables that keep Claude Code from sending the subscription token
 * to the Anthropic API: a credential it takes ahead of that token, another
 * endpoint, or a cloud provider it signs in to instead.
 */
export const OUTRANKING_VARIABLES: ReadonlySet<string> = new Set([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_GATEWAY',
]);
