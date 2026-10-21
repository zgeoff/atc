import type { HarnessPlugin } from '@atc/config';
import { buildAgentEntrySchema } from '@atc/config';
import { definePlugin } from '@atc/plugin-api';
import { createGrokAdapter } from './create-grok-adapter';

export const GROK_PLUGIN: HarnessPlugin = definePlugin({
  kind: 'harness',
  id: 'grok',
  configFields: [],
  configSchema: (context) =>
    buildAgentEntrySchema({ kind: 'grok', fields: [], defaultLabel: 'Grok' }, context),
  create: (config) => createGrokAdapter(config.entry),
});
