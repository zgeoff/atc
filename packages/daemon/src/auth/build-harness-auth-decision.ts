import type { AgentAdapter, HostCredentials } from '@atc/plugin-api';
import { decideHarnessAuth } from './decide-harness-auth';
import type { HarnessAuthDecision } from './decide-harness-auth';

// The decision for an agent on a host's credentials, which every launch, revive and list reads
// the same way, the agent's own config conflicts included.
export function buildHarnessAuthDecision(
  adapter: Pick<AgentAdapter, 'findAuthSelection' | 'findGuestEnvConflict' | 'signInFile'>,
  credentials: HostCredentials,
): HarnessAuthDecision {
  const conflict =
    credentials.kind === 'none' ? null : (adapter.findGuestEnvConflict?.(credentials.kind) ?? null);

  return decideHarnessAuth(
    adapter.findAuthSelection?.() ?? null,
    credentials,
    conflict,
    adapter.signInFile ?? null,
  );
}
