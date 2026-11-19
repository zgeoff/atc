import { CLAUDE_CREDENTIAL_VARIABLES } from './claude-credential-variables';

// each keeps Claude Code from sending the subscription token to the Anthropic
// API: a credential it takes first, another endpoint, or a cloud provider.
export const OUTRANKING_VARIABLES: ReadonlySet<string> = new Set([
  CLAUDE_CREDENTIAL_VARIABLES.authToken,
  CLAUDE_CREDENTIAL_VARIABLES.apiKey,
  CLAUDE_CREDENTIAL_VARIABLES.baseURL,
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_GATEWAY',
]);
