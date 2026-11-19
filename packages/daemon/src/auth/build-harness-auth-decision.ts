import type { AgentAdapter, HostCredentials } from '@atc/plugin-api';
import { decideHarnessAuth } from './decide-harness-auth';
import type { HarnessAuthDecision } from './decide-harness-auth';

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
