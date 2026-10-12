import { definePlugin } from '@atc/plugin-api/define-plugin';
import { EXECUTION_TARGET_CONFIG_SCHEMA } from '@atc/plugin-api/execution-target-config';
import { LocalPTYProvider } from './local-pty-provider';

/**
 * The execution plugin that runs sessions in PTYs on the daemon's own
 * host. Its targets take no options.
 */
export const LOCAL_PTY_PLUGIN = definePlugin({
  kind: 'execution',
  id: 'local-pty',
  configFields: [],
  configSchema: () => EXECUTION_TARGET_CONFIG_SCHEMA,
  create: () => new LocalPTYProvider(),
});
