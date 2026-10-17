import type { AgentConfigPlugin } from '@atc/config';
import { buildAgentEntrySchema } from '@atc/config';

// No stand-in checks a kind's auth; a test that needs that check takes the
// real plugin from its harness package.
export function buildStubHarnessPlugins(): AgentConfigPlugin[] {
  const claudeFields = ['settings', 'env', 'baseURL', 'apiKeyHelper', 'auth'];
  const codexFields = ['auth', 'appServer'];

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
