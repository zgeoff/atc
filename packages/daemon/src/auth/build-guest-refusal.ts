import { DaemonError } from '@atc/protocol/wire';

// An agent that plans no remote spawn: for want of an atc inside the host
// when the host has none, or because the agent never runs remotely.
export function buildGuestRefusal(
  provider: string,
  agent: string,
  target: string,
  hasNoATC: boolean,
): DaemonError {
  return hasNoATC
    ? new DaemonError(
        'unsupported_operation',
        `agent '${agent}' cannot run on target '${target}': its host has no atc to report through; run a compiled atc daemon on Linux, or set the target's guestATC to an atc installed in its image`,
        { provider, agent, problem: 'no_guest_atc' },
      )
    : new DaemonError(
        'unsupported_operation',
        `agent '${agent}' cannot run on a remote target such as '${target}'`,
        { provider, agent, problem: 'remote_unsupported' },
      );
}
