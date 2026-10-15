import type { TargetConfig } from '@atc/config';
import { buildTargetIdentity } from '@atc/store';
import type { ExecutionTarget } from '../build-execution-targets';
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

/**
 * The daemon's execution targets for configured target entries, as the
 * config load or the targets section parse gives them, in their order:
 * each `local-pty` entry runs its harnesses in memory through the
 * in-memory provider under the `local-pty` kind, which appends the entry's
 * id to `spawned` on every spawn and takes the host operations `hosts`
 * gives it, and an entry of any other kind has no provider, as a provider
 * this daemon lacks leaves it. Each target's identity is the real one for
 * its kind and options.
 */
export function buildStubTargets(
  targets: readonly TargetConfig[],

  // oxlint-disable-next-line prefer-readonly-parameter-types -- the stand-in appends to the caller's spawn list
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
