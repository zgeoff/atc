import type { HarnessPlugin } from '@atc/config';
import { buildClaudePlugin } from './build-claude-plugin';

export const CLAUDE_PLUGIN: HarnessPlugin = buildClaudePlugin();
