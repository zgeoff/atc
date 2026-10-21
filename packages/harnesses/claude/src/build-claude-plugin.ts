import type { HarnessPlugin } from '@atc/config';
import { buildAgentEntrySchema } from '@atc/config';
import { definePlugin } from '@atc/plugin-api';
import type { ClaudeAdapterOptions } from './claude-adapter-options';
import { readClaudeEntry } from './config/read-claude-entry';
import { createClaudeAdapter } from './create-claude-adapter';
import { createGatewayAdapter } from './gateway/create-gateway-adapter';

// The fields a Claude entry sets beside the ones every entry takes.
const CLAUDE_FIELDS = ['settings', 'env', 'baseURL', 'apiKeyHelper', 'auth', 'pluginDirs'];

export function buildClaudePlugin(options: ClaudeAdapterOptions = {}): HarnessPlugin {
  return definePlugin({
    kind: 'harness',
    id: 'claude',
    configFields: CLAUDE_FIELDS,
    configSchema: (context) =>
      buildAgentEntrySchema(
        { kind: 'claude', fields: CLAUDE_FIELDS, defaultLabel: 'Claude', read: readClaudeEntry },
        context,
      ),
    create: (config, host, context) => {
      const baseURL = config.entry.baseURL;

      return baseURL === undefined
        ? createClaudeAdapter(config.entry, context, host, options)
        : createGatewayAdapter({ ...config.entry, baseURL }, context, host, options);
    },
  });
}
