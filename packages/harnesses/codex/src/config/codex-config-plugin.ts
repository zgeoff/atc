import type { AgentConfigPlugin } from '@atc/config';
import { buildAgentEntrySchema } from '@atc/config';
import { readCodexEntry } from './read-codex-entry';

// The fields a Codex entry sets beside the ones every entry takes.
const CODEX_FIELDS = ['auth', 'appServer'];

export const CODEX_CONFIG_PLUGIN: AgentConfigPlugin = {
  id: 'codex',
  configFields: CODEX_FIELDS,
  configSchema: (context) =>
    buildAgentEntrySchema(
      { kind: 'codex', fields: CODEX_FIELDS, defaultLabel: 'Codex', read: readCodexEntry },
      context,
    ),
};
