import type { ExecutionTarget } from '../daemon/build-execution-targets';
import { buildTargetIdentity } from '../daemon/build-target-identity';
import type { TargetConfig } from '../shared/collect-targets';
import { buildStubPTYProvider } from './build-stub-pty-provider';

// What a target's provider does in place of the local one's: the
// capabilities it adds and the host preparation, sleep, and destroy it runs.
type HostOverride = Omit<
  NonNullable<Parameters<typeof buildStubPTYProvider>[0]>,
  'kind' | 'onSpawn'
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
 * each `local-pty` entry runs its harnesses on a real local
 * pseudo-terminal through a stand-in provider that appends the entry's id
 * to `spawned` on every spawn and takes the host operations `hosts` gives
 * it, and an entry of any other kind has no provider, as a provider this
 * daemon lacks leaves it. Each target's identity is the real one for its
 * kind and options.
 */
export function buildStubTargets(
  targets: readonly TargetConfig[],

  // oxlint-disable-next-line prefer-readonly-parameter-types -- the stand-in appends to the caller's spawn list
  config: StubTargetsConfig,
): ExecutionTarget[] {
  const hosts: Readonly<Record<string, HostOverride>> = { ...config.hosts };

  const providers = new Map(
    targets.map((target) => [
      target.id,
      buildStubPTYProvider({
        onSpawn: () => {
          config.spawned.push(target.id);
        },
        ...hosts[target.id],
      }),
    ]),
  );

  return targets.map((target) => ({
    id: target.id,
    kind: target.provider,
    options: target.options,
    identity: buildTargetIdentity(target.provider, target.options),
    provider: target.provider === 'local-pty' ? (providers.get(target.id) ?? null) : null,
  }));
}
