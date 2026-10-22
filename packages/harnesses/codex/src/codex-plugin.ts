import type { HarnessPlugin } from '@atc/config';
import { definePlugin } from '@atc/plugin-api';
import { CODEX_CONFIG_PLUGIN } from './config/codex-config-plugin';
import { createCodexAdapter } from './create-codex-adapter';

export const CODEX_PLUGIN: HarnessPlugin = definePlugin({
  kind: 'harness',
  ...CODEX_CONFIG_PLUGIN,
  create: (config, _host, context) => createCodexAdapter(config.entry, context),
});
