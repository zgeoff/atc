import {
  EXECUTION_TARGET_CONFIG_SCHEMA,
  TargetUnavailableError,
  definePlugin,
  formatPlaceURL,
} from '@atc/plugin-api';
import { collectAuthProfileProblems } from './auth/collect-auth-profile-problems';
import { createConfiguredImpProvider } from './create-configured-imp-provider';

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
    'maxMemoryMib',
    'guestDir',
    'guestATC',
    'rebindChangedAuth',
    'dropSysAdmin',
    'sessionEnv',
  ],

  // impd refuses a profile whose names break its rules, so a target is
  // unusable while any profile breaks them.
  configSchema: (context) =>
    EXECUTION_TARGET_CONFIG_SCHEMA.superRefine((config, ctx) => {
      for (const message of collectAuthProfileProblems(config.id, context.authProfiles)) {
        ctx.addIssue({ code: 'custom', message });
      }
    }),

  // options that never select an existing imp stay out of its identity
  identity: {
    version: 'reach-v1',
    ignoredOptions: [
      'image',
      'memoryMib',
      'maxMemoryMib',
      'guestATC',
      'rebindChangedAuth',
      'sessionEnv',
    ],
  },

  // the impd URL names the service; the token, image and prefix do not
  place: (options) => {
    const url = options['url'];

    return typeof url === 'string'
      ? { scope: 'shared', version: 'place-v1', parts: { url: formatPlaceURL(url) } }
      : { scope: 'daemon' };
  },
  create: (config, host) => {
    const built = createConfiguredImpProvider(config.id, config.options, host.version, config.env);

    if (built.provider === null) {
      throw new TargetUnavailableError(config.id, built.problem);
    }

    return built.provider;
  },
});
