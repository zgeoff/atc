import type { ExecutionTarget } from './build-execution-targets';
import type { ExecutionCapabilities } from './execution-provider';

export interface TargetEntry {
  readonly id: string;

  // The provider kind the config selects for the target.
  readonly provider: string;

  // Whether this daemon has a provider of that kind, so a spawn can run there.
  readonly available: boolean;
  readonly default: boolean;
  readonly capabilities: ExecutionCapabilities;
}

// What a target without a provider can do: nothing.
const NO_CAPABILITIES: ExecutionCapabilities = {
  spawn: false,
  attach: false,
  input: false,
  resize: false,
  kill: false,
  transfer: false,
  run: false,
  suspend: false,
  destroy: false,
};

/**
 * One `agents.list` target entry per configured target, in config order.
 * An entry holds the target's id, provider kind, and capabilities, never its
 * options, since those can hold a host's address or an account.
 */
export function buildTargetList(
  targets: readonly ExecutionTarget[],
  defaultTarget: string,
): TargetEntry[] {
  return targets.map((target) => ({
    id: target.id,
    provider: target.kind,
    available: target.provider !== null,
    default: target.id === defaultTarget,
    capabilities: target.provider?.capabilities ?? NO_CAPABILITIES,
  }));
}
