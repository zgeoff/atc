import type { AgentConfigPlugin } from '@atc/config';
import { buildAgentEntrySchema } from '@atc/config';
import { readClaudeEntry } from './read-claude-entry';

// The fields a Claude entry sets beside the ones every entry takes.
const CLAUDE_FIELDS = ['settings', 'env', 'baseURL', 'apiKeyHelper', 'auth', 'pluginDirs'];

export const CLAUDE_CONFIG_PLUGIN: AgentConfigPlugin = {
  id: 'claude',
  configFields: CLAUDE_FIELDS,
  configSchema: (context) =>
    buildAgentEntrySchema(
      { kind: 'claude', fields: CLAUDE_FIELDS, defaultLabel: 'Claude', read: readClaudeEntry },
      context,
    ),
};
