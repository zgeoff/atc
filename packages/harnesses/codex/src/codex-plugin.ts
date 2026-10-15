import type { HarnessPlugin } from '@atc/config';
import { buildAgentEntrySchema } from '@atc/config';
import { definePlugin } from '@atc/plugin-api';
import { CodexAdapter } from './codex-adapter';
import { readCodexEntry } from './config/read-codex-entry';

// The fields a Codex entry sets beside the ones every entry takes.
const CODEX_FIELDS = ['auth'];

/**
 * The Codex harness plugin.
 */
export const CODEX_PLUGIN: HarnessPlugin = definePlugin({
  kind: 'harness',
  id: 'codex',
  configFields: CODEX_FIELDS,
  configSchema: (context) =>
    buildAgentEntrySchema(
      { kind: 'codex', fields: CODEX_FIELDS, defaultLabel: 'Codex', read: readCodexEntry },
      context,
    ),
  create: (config, _host, context) => new CodexAdapter(config.entry, context),
});
