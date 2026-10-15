import { systemClock } from '@atc/core';
import { EXECUTION_TARGET_CONFIG_SCHEMA, definePlugin } from '@atc/plugin-api';
import { LocalPTYProvider } from './local-pty-provider';
import { startSessionScopes } from './start-session-scopes';

/**
 * The execution plugin that runs sessions in PTYs on the daemon's own
 * host. Its targets take no options.
 */
export const LOCAL_PTY_PLUGIN = definePlugin({
  kind: 'execution',
  id: 'local-pty',
  configFields: [],
  configSchema: () => EXECUTION_TARGET_CONFIG_SCHEMA,
  create: () => new LocalPTYProvider(systemClock, startSessionScopes()),
});
