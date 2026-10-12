import type { AgentConfigPlugin } from '@atc/config/agent-entry';
import { buildAgentEntrySchema } from '@atc/config/build-agent-entry-schema';

/**
 * Stand-ins for the config side of the harness plugins atc ships, in the
 * same order and with the same ids, fields, and default labels. Each reads
 * the fields every entry takes and checks the types of its own, but runs no
 * check of a kind's `auth`, so a test that needs that check takes the real
 * plugin from its harness package.
 */
export function buildStubHarnessPlugins(): AgentConfigPlugin[] {
  const claudeFields = ['settings', 'env', 'baseURL', 'apiKeyHelper', 'auth'];
  const codexFields = ['auth'];

  return [
    {
      id: 'claude',
      configFields: claudeFields,
      configSchema: (context) =>
        buildAgentEntrySchema(
          { kind: 'claude', fields: claudeFields, defaultLabel: 'Claude' },
          context,
        ),
    },
    {
      id: 'grok',
      configFields: [],
      configSchema: (context) =>
        buildAgentEntrySchema({ kind: 'grok', fields: [], defaultLabel: 'Grok' }, context),
    },
    {
      id: 'codex',
      configFields: codexFields,
      configSchema: (context) =>
        buildAgentEntrySchema(
          { kind: 'codex', fields: codexFields, defaultLabel: 'Codex' },
          context,
        ),
    },
  ];
}
