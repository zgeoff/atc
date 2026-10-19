import type { CredentialBroker } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { RuntimeAuthBinding } from '@atc/store';
import type { AuthBinding } from './build-auth-binding';
import type { RuntimeAuthLedger } from './runtime-auth-ledger';
import { tryRevokeGrant } from './try-revoke-grant';

// A rebind attempt: the binding row it moves on from, the binding it moves
// to, and the revision and attempt it records each grant under.
interface RebindAttempt {
  readonly row: RuntimeAuthBinding;
  readonly binding: AuthBinding;
  readonly revision: number;
  readonly attemptID: string;
}

// Grants each secret of the new binding the host lacks, recording one it
// already holds as preexisting, then revokes each held grant the new
// binding drops.
export async function applyRebindGrants(
  ledger: RuntimeAuthLedger,
  host: CredentialBroker,
  attempt: RebindAttempt,
): Promise<void> {
  const row = attempt.row;
  const binding = attempt.binding;
  const revision = attempt.revision;
  const attemptID = attempt.attemptID;

  const held = await host.readGrants(row.hostName);

  const bound = binding.secrets.map((secret) => secret.secret);

  for (const secret of bound) {
    const grant = { hostKey: row.hostKey, secret, revision, attemptID };

    if (held.includes(secret)) {
      await ledger.store.upsertAuthGrant(
        { ...grant, preexisting: true, phase: 'granted' },
        ledger.now(),
      );
    } else {
      await ledger.store.upsertAuthGrant(
        { ...grant, preexisting: false, phase: 'granting' },
        ledger.now(),
      );

      await host.createGrant(row.hostName, secret);

      await ledger.store.upsertAuthGrant(
        { ...grant, preexisting: false, phase: 'granted' },
        ledger.now(),
      );
    }
  }

  for (const secret of held.filter((name) => !bound.includes(name))) {
    const grant = {
      hostKey: row.hostKey,
      secret,
      revision,
      attemptID,
      preexisting: true,
    };

    await ledger.store.upsertAuthGrant({ ...grant, phase: 'revoking' }, ledger.now());

    if (!(await tryRevokeGrant(host, row.hostName, secret))) {
      await ledger.store.upsertAuthGrant({ ...grant, phase: 'revocation_pending' }, ledger.now());

      throw new DaemonError(
        'auth_revocation_pending',
        `host ${row.hostName} may still hold ${secret}, which the new binding drops`,
        { host: row.hostKey, pending: [secret] },
      );
    }

    await ledger.store.upsertAuthGrant({ ...grant, phase: 'revoked' }, ledger.now());
  }
}
