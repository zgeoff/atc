import type { BrokerHost, CredentialBroker } from '@atc/plugin-api';
import type { RuntimeAuthBinding, RuntimeAuthGrant } from '@atc/store';
import { parseBoundSecrets } from './parse-bound-secrets';
import type { RuntimeAuthLedger } from './runtime-auth-ledger';
import { tryRevokeGrant } from './try-revoke-grant';
import { verifyCleanupAuthority } from './verify-cleanup-authority';

// Revokes each bound or recorded grant and returns the secrets it could
// not confirm gone. An imp impd shows gone took every grant with it.
export async function revokeGrants(
  ledger: RuntimeAuthLedger,
  host: CredentialBroker | null,
  row: RuntimeAuthBinding,
): Promise<string[]> {
  const grants = await ledger.store.collectAuthGrants(row.hostKey);

  const secrets = collectBindingSecrets(row, grants);

  if (host === null || row.impID === null) {
    await updateGrantPhases(ledger, { row, grants, secrets, phase: 'revocation_pending' });

    return secrets;
  }

  const recorded = { name: row.impName, id: row.impID };
  let imp: BrokerHost | null;

  try {
    imp = await verifyCleanupAuthority(host, recorded);
  } catch {
    await updateGrantPhases(ledger, { row, grants, secrets, phase: 'revocation_pending' });

    return secrets;
  }

  if (imp === null) {
    await updateGrantPhases(ledger, { row, grants, secrets, phase: 'revoked' });

    return [];
  }

  const pending: string[] = [];

  for (const secret of secrets) {
    await updateGrantPhases(ledger, { row, grants, secrets: [secret], phase: 'revoking' });

    const revoked = await tryRevokeGrant(host, row.impName, secret);

    const phase = revoked ? 'revoked' : 'revocation_pending';

    await updateGrantPhases(ledger, { row, grants, secrets: [secret], phase });

    if (!revoked) {
      pending.push(secret);
    }
  }

  return pending;
}

// The secrets a binding grants and any its grant rows still record.
function collectBindingSecrets(
  row: RuntimeAuthBinding,
  grants: readonly RuntimeAuthGrant[],
): string[] {
  const bound = parseBoundSecrets(row.bindingJSON);

  return [...new Set([...bound, ...grants.map((grant) => grant.secret)])].toSorted();
}

// The phase each named secret's grant row of a binding moves to, with the
// rows the binding recorded before the move.
interface GrantPhaseUpdate {
  readonly row: RuntimeAuthBinding;
  readonly grants: readonly RuntimeAuthGrant[];
  readonly secrets: readonly string[];
  readonly phase: RuntimeAuthGrant['phase'];
}

async function updateGrantPhases(
  ledger: RuntimeAuthLedger,
  update: GrantPhaseUpdate,
): Promise<void> {
  const row = update.row;
  const grants = update.grants;
  const secrets = update.secrets;
  const phase = update.phase;

  for (const secret of secrets) {
    const grant = grants.find((g) => g.secret === secret);

    await ledger.store.upsertAuthGrant(
      {
        hostKey: row.hostKey,
        secret,
        revision: grant?.revision ?? row.revision,
        attemptID: grant?.attemptID ?? row.attemptID,
        preexisting: grant?.preexisting ?? false,
        phase,
      },
      ledger.now(),
    );
  }
}
