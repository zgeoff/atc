import type { CredentialBroker } from '@atc/plugin-api';
import type { SessionID } from '@atcx/contract';
import type { RuntimeAuthLedger } from './runtime-auth-ledger';
import { tryRevokeGrant } from './try-revoke-grant';

interface RebindGrantsRemoval {
  readonly hostKey: SessionID;
  readonly hostName: string;
  readonly attemptID: string;
}

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
