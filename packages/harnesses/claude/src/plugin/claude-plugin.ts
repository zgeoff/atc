import type { HarnessPlugin } from '@atc/config';
import { buildClaudePlugin } from './build-claude-plugin';

// no headless runner: reading config and a test that starts no headless run both take this
export const CLAUDE_PLUGIN: HarnessPlugin = buildClaudePlugin();
