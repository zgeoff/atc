import {
  EXECUTION_TARGET_CONFIG_SCHEMA,
  TargetUnavailableError,
  definePlugin,
} from '@atc/plugin-api';
import { buildImpProvider } from './build-imp-provider';

export const IMP_PLUGIN = definePlugin({
  kind: 'execution',
  id: 'imp',
  configFields: [
    'url',
    'tokenEnv',
    'tokenFile',
    'impPrefix',
    'image',
    'memoryMib',
    'guestDir',
    'guestATC',
    'rebindChangedAuth',
    'dropSysAdmin',
  ],
  configSchema: () => EXECUTION_TARGET_CONFIG_SCHEMA,

  // options that never select an existing imp stay out of its identity
  identity: {
    version: 'reach-v1',
    ignoredOptions: ['image', 'memoryMib', 'guestATC', 'rebindChangedAuth'],
  },
  create: (config, host) => {
    const built = buildImpProvider(config.id, config.options, host.version, config.env);

    if (built.provider === null) {
      throw new TargetUnavailableError(config.id, built.problem);
    }

    return built.provider;
  },
});
