import type { CredentialBroker } from '@atc/plugin-api';
import type { SessionID } from '@atcx/contract';
import type { RuntimeAuthLedger } from './runtime-auth-ledger';
import { tryRevokeGrant } from './try-revoke-grant';

// The rebind attempt whose added grants go: the host, its name on the broker, and the
// attempt that added them.
interface RebindGrantsRemoval {
  readonly hostKey: SessionID;
  readonly hostName: string;
  readonly attemptID: string;
}

// Revokes each grant a rebind attempt added, which only it can have
// made, and records each it could not confirm gone as pending.
export async function removeRebindGrants(
  ledger: RuntimeAuthLedger,
  host: CredentialBroker | null,
  removal: RebindGrantsRemoval,
): Promise<void> {
  const hostKey = removal.hostKey;
  const hostName = removal.hostName;
  const attemptID = removal.attemptID;

  const grants = await ledger.store.readAuthGrants(hostKey);

  const added = grants.filter(
    (grant) =>
      grant.attemptID === attemptID &&
      !grant.preexisting &&
      (grant.phase === 'granting' ||
        grant.phase === 'granted' ||
        grant.phase === 'uncertain' ||
        grant.phase === 'revocation_pending'),
  );

  for (const grant of added) {
    const revoked = host === null ? false : await tryRevokeGrant(host, hostName, grant.secret);

    await ledger.store.upsertAuthGrant(
      { ...grant, phase: revoked ? 'revoked' : 'revocation_pending' },
      ledger.now(),
    );
  }
}
