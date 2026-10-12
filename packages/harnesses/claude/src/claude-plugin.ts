import type { HarnessPlugin } from '@atc/config/agent-entry';
import { buildClaudePlugin } from './build-claude-plugin';

/**
 * The Claude harness plugin with its adapters on their default paths and
 * no headless runner, which reading config and a test that creates no
 * headless run both take.
 */
export const CLAUDE_PLUGIN: HarnessPlugin = buildClaudePlugin();
