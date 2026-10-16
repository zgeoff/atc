import {
  EXECUTION_TARGET_CONFIG_SCHEMA,
  TargetUnavailableError,
  definePlugin,
} from '@atc/plugin-api';
import { buildImpProvider } from './build-imp-provider';

/**
 * The execution plugin that runs sessions on imps through impd. A target
 * without a `url`, or with options that keep it from impd, gets no provider:
 * the factory throws, with the problem when the options hold one.
 */
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
  create: (config, host) => {
    const built = buildImpProvider(config.id, config.options, host.version, config.env);

    if (built.provider === null) {
      throw new TargetUnavailableError(config.id, built.problem);
    }

    return built.provider;
  },
});
