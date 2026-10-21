import type { HarnessPlugin } from '@atc/config';
import { buildAgentEntrySchema } from '@atc/config';
import { definePlugin } from '@atc/plugin-api';
import { readCodexEntry } from './config/read-codex-entry';
import { createCodexAdapter } from './create-codex-adapter';

// The fields a Codex entry sets beside the ones every entry takes.
const CODEX_FIELDS = ['auth', 'appServer'];

export const CODEX_PLUGIN: HarnessPlugin = definePlugin({
  kind: 'harness',
  id: 'codex',
  configFields: CODEX_FIELDS,
  configSchema: (context) =>
    buildAgentEntrySchema(
      { kind: 'codex', fields: CODEX_FIELDS, defaultLabel: 'Codex', read: readCodexEntry },
      context,
    ),
  create: (config, _host, context) => createCodexAdapter(config.entry, context),
});
