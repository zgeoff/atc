import type { AgentConfigPlugin } from '@atc/config';
import { buildAgentEntrySchema } from '@atc/config';

export const GROK_CONFIG_PLUGIN: AgentConfigPlugin = {
  id: 'grok',
  configFields: [],
  configSchema: (context) =>
    buildAgentEntrySchema({ kind: 'grok', fields: [], defaultLabel: 'Grok' }, context),
};
