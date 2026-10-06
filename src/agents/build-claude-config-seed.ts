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
 * the clone's MCP servers, on its first start.
 */
export function buildClaudeConfigSeed(
  trustedRoot: string | null,
): Readonly<Record<string, string>> {
  const seed =
    trustedRoot === null
      ? ONBOARDED_CONFIG
      : { ...ONBOARDED_CONFIG, projects: { [trustedRoot]: TRUSTED_PROJECT } };

  return { [CLAUDE_CONFIG_SEED_FILE]: JSON.stringify(seed, null, 2) };
}

const ONBOARDED_CONFIG = { hasCompletedOnboarding: true };
const TRUSTED_PROJECT = { hasTrustDialogAccepted: true, enableAllProjectMcpServers: true };
