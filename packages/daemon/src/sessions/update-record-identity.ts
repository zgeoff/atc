import { buildRecordSubject } from './build-record-subject';
import type { SessionRegistry } from './create-session-registry';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';

interface UpdateRecordIdentityDeps {
  readonly registry: Pick<SessionRegistry, 'requireExecution'>;
  readonly callbacks: Pick<SessionCallbacks, 'findRecords' | 'log'>;
}

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

    // A remote host that is asleep or in an unknown state cannot run a command, so the copy of the
    // record on it is skipped. The next harness start writes the stored record there.
    const placeCopy = !provider.remote || session.vm === 'awake' || session.vm === 'none';

    await records.updateIdentity(buildRecordSubject(session, provider), placeCopy);
  } catch (error) {
    deps.callbacks.log(
      `atc could not record the name and transcript of session ${session.id} (${String(error)})`,
    );
  }
}
