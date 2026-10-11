import { CLAUDE_CONFIG_SEED_FILE } from './claude-config-seed-file';

/**
 * The guest file that seeds a session's own Claude config folder with the
 * state the CLI reads from `.claude.json` to start without its first-run
 * onboarding, and with folder trust for `trustedRoot`, the exact root of a
 * verified clone, when one is given. Trust also approves every MCP server
 * the clone's own `.mcp.json` declares, so an unattended session never
 * waits on the CLI's approval prompt. It holds no account: the placeholder
 * credential is what keeps the CLI from asking for a login. Without a
 * trusted root the CLI asks a person to trust the workspace, and to approve
 * the clone's MCP servers, on its first start. `approvedAPIKey`, when
 * given, is a placeholder the session reads as its API key variable: the
 * seed approves it the way the CLI records a person's approval, by its
 * last 20 characters, since the CLI otherwise asks whether to use it.
 */
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

const ONBOARDED_CONFIG = { hasCompletedOnboarding: true };

// How many trailing characters of an API key the CLI keeps to record a
// person's answer about it.
const API_KEY_SUFFIX_LENGTH = 20;
const TRUSTED_PROJECT = { hasTrustDialogAccepted: true, enableAllProjectMcpServers: true };
