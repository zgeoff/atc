import { EXECUTION_TARGET_CONFIG_SCHEMA, definePlugin } from '@atc/plugin-api';
import { systemClock } from '@zgeoff/std';
import { createLocalPTYProvider } from './create-local-pty-provider';
import { startSessionScopes } from './session-scopes/start-session-scopes';

export const LOCAL_PTY_PLUGIN = definePlugin({
  kind: 'execution',
  id: 'local-pty',
  configFields: [],
  configSchema: () => EXECUTION_TARGET_CONFIG_SCHEMA,
  create: () => createLocalPTYProvider(systemClock, startSessionScopes()),
});
