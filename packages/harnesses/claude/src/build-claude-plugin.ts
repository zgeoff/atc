import type { HarnessPlugin } from '@atc/config';
import { buildAgentEntrySchema } from '@atc/config';
import { definePlugin } from '@atc/plugin-api';
import { ClaudeAdapter } from './claude-adapter';
import type { ClaudeAdapterOptions } from './claude-adapter-options';
import { readClaudeEntry } from './config/read-claude-entry';
import { GatewayAdapter } from './gateway/gateway-adapter';

// The fields a Claude entry sets beside the ones every entry takes.
const CLAUDE_FIELDS = ['settings', 'env', 'baseURL', 'apiKeyHelper', 'auth'];

/**
 * The Claude harness plugin. An entry with a base URL creates a gateway
 * adapter, and one without creates stock Claude's. `options` hold where
 * both write their launch files and how they run Claude headless.
 */
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
        ? new ClaudeAdapter(config.entry, context, host, options)
        : new GatewayAdapter({ ...config.entry, baseURL }, context, host, options);
    },
  });
}
