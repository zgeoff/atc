import type { SessionID } from '@atc/core';
import type { DeclaredScope, PublishedRecord } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import type { PublishedRecords } from './published-records';
import type { SessionRegistry } from './session-registry';

interface UpdateSessionScopeDeps {
  readonly registry: Pick<SessionRegistry, 'sessions' | 'requireExecution'>;
  readonly records: PublishedRecords | null;
}

export async function updateSessionScope(
  deps: UpdateSessionScopeDeps,
  id: SessionID,
  scope: DeclaredScope,
): Promise<PublishedRecord | 'missing'> {
  const s = deps.registry.sessions.find((x) => x.id === id);

  if (s === undefined) {
    return 'missing';
  }

  if (deps.records === null) {
    throw new DaemonError('unsupported', 'this daemon publishes no session records');
  }

  const provider = deps.registry.requireExecution(s, 'spawn').provider;

  // the scope checks run on the session's host
  if (provider.remote && s.vm !== 'awake') {
    throw new DaemonError(
      'host_unavailable',
      `the host of session ${id} is not awake; revive the session before adding to its scope`,
      { provider: provider.kind, problem: 'host_asleep', host: s.hostKey },
    );
  }

  const subject = {
    session: s.id,
    target: s.target,
    provider,
    host: s.hostKey,
    dir: s.cwd,
    workspace: s.workspace ?? null,
  };

  const record = await deps.records.updateScope(subject, scope);

  return record;
}
