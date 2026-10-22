import type { AgentConfigPlugin } from '@atc/config';
import { CLAUDE_CONFIG_PLUGIN } from '@atc/harness-claude/config';
import { CODEX_CONFIG_PLUGIN } from '@atc/harness-codex/config';
import { GROK_CONFIG_PLUGIN } from '@atc/harness-grok/config';

// Reading config takes only the config entries, which leave out each
// harness's adapter modules, so a client boot never loads them.
export const SHIPPED_HARNESS_PLUGINS: readonly AgentConfigPlugin[] = [
  CLAUDE_CONFIG_PLUGIN,
  GROK_CONFIG_PLUGIN,
  CODEX_CONFIG_PLUGIN,
];
