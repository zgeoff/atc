import { buildRecordSubject } from './build-record-subject';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';
import type { SessionRegistry } from './session-registry';

interface UpdateRecordIdentityDeps {
  readonly registry: Pick<SessionRegistry, 'requireExecution'>;
  readonly callbacks: Pick<SessionCallbacks, 'findRecords' | 'log'>;
}

// Records the session's current name and transcript path in its record. A
// failure is only logged, because the record's next write takes the same
// values from the session.
export async function updateRecordIdentity(
  deps: UpdateRecordIdentityDeps,
  session: Readonly<Session>,
): Promise<void> {
  const records = deps.callbacks.findRecords();

  if (records === null) {
    return;
  }

  try {
    const provider = deps.registry.requireExecution(session, 'spawn').provider;

    // a remote host that sleeps runs no command, so its copy waits for the
    // next harness start, which places the stored record
    const placeCopy = !provider.remote || session.vm === 'awake';

    await records.updateIdentity(buildRecordSubject(session, provider), placeCopy);
  } catch (error) {
    deps.callbacks.log(
      `atc could not record the name and transcript of session ${session.id} (${String(error)})`,
    );
  }
}
