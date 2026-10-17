import { CLAUDE_CONFIG_SEED_FILE } from './claude-config-seed-file';

export function buildClaudeConfigSeed(
  trustedRoot: string | null,
  approvedAPIKey: string | null = null,
): Readonly<Record<string, string>> {
  const seed = {
    ...ONBOARDED_CONFIG,
    ...(approvedAPIKey === null
      ? {}
      : {
          customApiKeyResponses: {
            approved: [approvedAPIKey.trim().slice(-API_KEY_SUFFIX_LENGTH)],
            rejected: [],
          },
        }),
    ...(trustedRoot === null ? {} : { projects: { [trustedRoot]: TRUSTED_PROJECT } }),
  };

  return { [CLAUDE_CONFIG_SEED_FILE]: JSON.stringify(seed, null, 2) };
}

// Marking the offer as seen never turns the block on, so a read outside
// the working directories still goes through the session's permission mode.
const ONBOARDED_CONFIG = { hasCompletedOnboarding: true, hasSeenAutoModeOutsideReadPrompt: true };

// the CLI records a person's approval of an api key by its trailing characters, and asks
// whether to use any key it holds no approval for
const API_KEY_SUFFIX_LENGTH = 20;
const TRUSTED_PROJECT = { hasTrustDialogAccepted: true, enableAllProjectMcpServers: true };
