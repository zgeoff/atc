import type { TargetConfig } from '@atc/config';
import { runLocalCommand } from '@atc/plugin-api/test-utils/run-local-command';
import { buildTargetIdentity } from '@atc/store';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { buildStubMemoryProvider } from './build-stub-memory-provider';

type HostOverride = Pick<
  NonNullable<Parameters<typeof buildStubMemoryProvider>[0]>,
  'capabilities' | 'prepareHost' | 'suspendHost' | 'destroyHost'
>;

interface StubTargetsConfig {
  readonly spawned: string[];

  readonly hosts?: Readonly<Record<string, HostOverride>>;

  readonly onStart?: NonNullable<Parameters<typeof buildStubMemoryProvider>[0]>['onStart'];
}

export function buildStubTargets(
  targets: readonly TargetConfig[],

  config: StubTargetsConfig,
): ExecutionTarget[] {
  const hosts: Readonly<Record<string, HostOverride>> = { ...config.hosts };

  return targets.map((target) => ({
    id: target.id,
    kind: target.provider,
    options: target.options,
    identity: buildTargetIdentity(target.provider, target.options),
    provider:
      target.provider === 'local-pty'
        ? buildStubMemoryProvider({
            kind: 'local-pty',
            runCommand: runLocalCommand,
            onSpawn: () => {
              config.spawned.push(target.id);
            },
            ...(config.onStart === undefined ? {} : { onStart: config.onStart }),
            ...hosts[target.id],
          })
        : null,
  }));
}
