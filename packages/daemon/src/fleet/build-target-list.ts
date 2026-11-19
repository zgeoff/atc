import type { ExecutionCapabilities, ExecutionProvider } from '@atc/plugin-api';
import { getHostCredentials } from '@atc/plugin-api';
import type { ExecutionTarget } from './build-execution-targets';

export interface TargetEntry {
  readonly id: string;

  readonly provider: string;

  readonly identity: string;

  readonly available: boolean;

  readonly remote: boolean;
  readonly default: boolean;
  readonly capabilities: ExecutionCapabilities;

  readonly brokerAuth: boolean;
}

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
  relay: false,
};

export function buildTargetList(
  targets: readonly ExecutionTarget[],
  defaultTarget: string | null,
): TargetEntry[] {
  // Leave a target's options out of the list. They can hold a host's address or an account.
  return targets.map((target) => ({
    id: target.id,
    provider: target.kind,
    identity: target.identity,
    available: target.provider !== null,
    remote: target.provider?.remote ?? false,
    default: target.id === defaultTarget,
    capabilities: target.provider?.capabilities ?? NO_CAPABILITIES,
    brokerAuth: isBrokered(target.provider),
  }));
}

function isBrokered(provider: ExecutionProvider | null): boolean {
  if (provider === null) {
    return false;
  }

  const kind = getHostCredentials(provider).kind;

  return kind === 'broker' || kind === 'routed';
}
