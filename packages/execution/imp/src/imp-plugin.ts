import {
  EXECUTION_TARGET_CONFIG_SCHEMA,
  TargetUnavailableError,
  definePlugin,
} from '@atc/plugin-api';
import { collectAuthProfileProblems } from './collect-auth-profile-problems';
import { createImpProvider } from './create-imp-provider';

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
    ignoredOptions: ['image', 'memoryMib', 'guestATC', 'rebindChangedAuth'],
  },
  create: (config, host) => {
    const built = createImpProvider(config.id, config.options, host.version, config.env);

    if (built.provider === null) {
      throw new TargetUnavailableError(config.id, built.problem);
    }

    return built.provider;
  },
});
