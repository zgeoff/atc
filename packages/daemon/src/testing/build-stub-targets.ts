import type { TargetConfig } from '@atc/config';
import { buildTargetIdentity } from '@atc/store';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { buildStubMemoryProvider } from './build-stub-memory-provider';

// What a target's provider does in place of the in-memory defaults: the
// capabilities it adds and the host preparation, sleep, and destroy it runs.
type HostOverride = Pick<
  NonNullable<Parameters<typeof buildStubMemoryProvider>[0]>,
  'capabilities' | 'prepareHost' | 'suspendHost' | 'destroyHost'
>;

interface StubTargetsConfig {
  // Each spawn appends its target's id here, in order.
  readonly spawned: string[];

  // Host operations of their own for the targets they name.
  readonly hosts?: Readonly<Record<string, HostOverride>>;
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
            onSpawn: () => {
              config.spawned.push(target.id);
            },
            ...hosts[target.id],
          })
        : null,
  }));
}
