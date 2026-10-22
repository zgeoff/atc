import type { HarnessPlugin } from '@atc/config';
import { definePlugin } from '@atc/plugin-api';
import type { ClaudeAdapterOptions } from './claude-adapter-options';
import { CLAUDE_CONFIG_PLUGIN } from './config/claude-config-plugin';
import { createClaudeAdapter } from './create-claude-adapter';
import { createGatewayAdapter } from './gateway/create-gateway-adapter';

export function buildClaudePlugin(options: ClaudeAdapterOptions = {}): HarnessPlugin {
  return definePlugin({
    kind: 'harness',
    ...CLAUDE_CONFIG_PLUGIN,
    create: (config, host, context) => {
      const baseURL = config.entry.baseURL;

      return baseURL === undefined
        ? createClaudeAdapter(config.entry, context, host, options)
        : createGatewayAdapter({ ...config.entry, baseURL }, context, host, options);
    },
  });
}
