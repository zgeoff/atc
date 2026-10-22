import type { HarnessPlugin } from '@atc/config';
import { definePlugin } from '@atc/plugin-api';
import { GROK_CONFIG_PLUGIN } from './config/grok-config-plugin';
import { createGrokAdapter } from './create-grok-adapter';

export const GROK_PLUGIN: HarnessPlugin = definePlugin({
  kind: 'harness',
  ...GROK_CONFIG_PLUGIN,
  create: (config) => createGrokAdapter(config.entry),
});
