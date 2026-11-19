import { isCompiledBinary } from '@atc/config/host';
import {
  EXECUTION_TARGET_CONFIG_SCHEMA,
  TargetUnavailableError,
  definePlugin,
} from '@atc/plugin-api';
import { parseDockerTarget } from './config/parse-docker-target';
import { createDockerProvider } from './create-docker-provider';
import { createEngineClient } from './engine/create-engine-client';

export const DOCKER_PLUGIN = definePlugin({
  kind: 'execution',
  id: 'docker',
  configFields: ['image', 'socket', 'namePrefix', 'signInVolume', 'guestDir'],

  configSchema: () =>
    EXECUTION_TARGET_CONFIG_SCHEMA.superRefine((config, ctx) => {
      const parsed = parseDockerTarget(config.id, config.options);

      if (parsed.kind === 'refused') {
        ctx.addIssue({ code: 'custom', message: parsed.problem });
      }
    }),

  // a new image reaches each container the provider creates after it, so it never selects a host
  identity: { version: 'docker-v1', ignoredOptions: ['image'] },

  create: (config, host) => {
    const parsed = parseDockerTarget(config.id, config.options);

    if (parsed.kind === 'refused') {
      throw new TargetUnavailableError(config.id, parsed.problem);
    }

    // each container runs the daemon's own binary, which a daemon run from source lacks
    if (!isCompiledBinary()) {
      throw new TargetUnavailableError(
        config.id,
        "compiled_binary_required: the docker provider runs the daemon's compiled binary in each container, and this daemon runs from source",
      );
    }

    return createDockerProvider(createEngineClient(parsed.target.socket), parsed.target, {
      targetID: config.id,
      atcBinary: process.execPath,
      stateDir: host.stateDir,
      log: host.log,
    });
  },
});
