import type { HarnessPlugin } from '@atc/config/agent-entry';
import { buildClaudePlugin } from '@atc/harness-claude/build-claude-plugin';
import type { ClaudeAdapterOptions } from '@atc/harness-claude/claude-adapter-options';
import { CODEX_PLUGIN } from '@atc/harness-codex/codex-plugin';
import { GROK_PLUGIN } from '@atc/harness-grok/grok-plugin';

/**
 * The harness plugins atc ships, in the order a config without `agents`
 * registers them. `options` hold where the Claude-family adapters write
 * their launch files and how they run Claude headless; reading config
 * takes none of them.
 */
export function buildHarnessPlugins(options: ClaudeAdapterOptions = {}): HarnessPlugin[] {
  return [buildClaudePlugin(options), GROK_PLUGIN, CODEX_PLUGIN];
}
