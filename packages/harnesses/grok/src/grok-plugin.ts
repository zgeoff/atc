import type { HarnessPlugin } from '@atc/config';
import { buildAgentEntrySchema } from '@atc/config';
import { definePlugin } from '@atc/plugin-api';
import { GrokAdapter } from './grok-adapter';

/**
 * The Grok harness plugin. A Grok entry sets only the fields every entry
 * takes.
 */
export const GROK_PLUGIN: HarnessPlugin = definePlugin({
  kind: 'harness',
  id: 'grok',
  configFields: [],
  configSchema: (context) =>
    buildAgentEntrySchema({ kind: 'grok', fields: [], defaultLabel: 'Grok' }, context),
  create: (config) => new GrokAdapter(config.entry),
});
