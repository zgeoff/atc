import type { ExecutionCapabilities } from '@atc/plugin-api';
import type { ExecutionTarget } from './build-execution-targets';

export interface TargetEntry {
  readonly id: string;

  // The provider kind the config selects for the target.
  readonly provider: string;

  // The identity a session spawned on the target binds to.
  readonly identity: string;

  // Whether this daemon has a provider of that kind, so a spawn can run there.
  readonly available: boolean;
  readonly default: boolean;
  readonly capabilities: ExecutionCapabilities;

  // Whether the target's provider reaches impd's credential broker, so an
  // agent that takes its credential from the broker can run there.
  readonly brokerAuth: boolean;
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
  headless: false,
  suspend: false,
  destroy: false,
};

export function buildTargetList(
  targets: readonly ExecutionTarget[],
  defaultTarget: string | null,
): TargetEntry[] {
  // never a target's options, which can hold a host's address or an account
  return targets.map((target) => ({
    id: target.id,
    provider: target.kind,
    identity: target.identity,
    available: target.provider !== null,
    default: target.id === defaultTarget,
    capabilities: target.provider?.capabilities ?? NO_CAPABILITIES,
    brokerAuth: target.provider?.brokerAuth !== undefined,
  }));
}
