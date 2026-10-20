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
  const session = deps.registry.sessions.find((x) => x.id === id);

  if (session === undefined) {
    return 'missing';
  }

  if (deps.records === null) {
    throw new DaemonError('unsupported', 'this daemon publishes no session records');
  }

  const provider = deps.registry.requireExecution(session, 'spawn').provider;

  // the scope checks run on the session's host
  if (provider.remote && session.vm !== 'awake') {
    throw new DaemonError(
      'host_unavailable',
      `the host of session ${id} is not awake; revive the session before adding to its scope`,
      { provider: provider.kind, problem: 'host_asleep', host: session.hostKey },
    );
  }

  const subject = {
    session: session.id,
    target: session.target,
    provider,
    host: session.hostKey,
    directory: session.cwd,
    workspace: session.workspace ?? null,
  };

  const record = await deps.records.updateScope(subject, scope);

  return record;
}
