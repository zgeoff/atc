import type { HarnessPlugin } from '@atc/config';
import { buildClaudePlugin } from '@atc/harness-claude';
import type { ClaudeAdapterOptions } from '@atc/harness-claude';
import { CODEX_PLUGIN } from '@atc/harness-codex';
import { GROK_PLUGIN } from '@atc/harness-grok';

export function buildHarnessPlugins(options: ClaudeAdapterOptions = {}): HarnessPlugin[] {
  // a config without agents registers them in this order.
  return [buildClaudePlugin(options), GROK_PLUGIN, CODEX_PLUGIN];
}
