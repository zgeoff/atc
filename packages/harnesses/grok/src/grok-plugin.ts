import type { HarnessPlugin } from '@atc/config';
import { buildAgentEntrySchema } from '@atc/config';
import { definePlugin } from '@atc/plugin-api';
import { GrokAdapter } from './grok-adapter';

export const GROK_PLUGIN: HarnessPlugin = definePlugin({
  kind: 'harness',
  id: 'grok',
  configFields: [],
  configSchema: (context) =>
    buildAgentEntrySchema({ kind: 'grok', fields: [], defaultLabel: 'Grok' }, context),
  create: (config) => new GrokAdapter(config.entry),
});
