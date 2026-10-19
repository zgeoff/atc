import { randomUUID } from 'node:crypto';
import type { CredentialBroker } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { RuntimeAuthBinding } from '@atc/store';
import { applyRebindGrants } from './apply-rebind-grants';
import { BrokerAuthorityError } from './broker-authority-error';
import type { AuthBinding } from './build-auth-binding';
import { planRebindStart } from './plan-rebind-start';
import { removeRebindGrants } from './remove-rebind-grants';
import type { RuntimeAuthLedger } from './runtime-auth-ledger';
import { toAuthRefusal } from './to-auth-refusal';
import { verifyCleanupAuthority } from './verify-cleanup-authority';
import { verifyGate } from './verify-gate';

// The rebind's own steps on a binding read under the host's lock, which
// leave the admissions on the host to the caller.
export async function updateBindingLocked(
  ledger: RuntimeAuthLedger,
  host: CredentialBroker,
  row: RuntimeAuthBinding,
  binding: AuthBinding,
): Promise<number> {
  const hostKey = row.hostKey;

  if (planRebindStart(row) === 'blocked') {
    throw new DaemonError(
      'auth_blocked',
      `the runtime auth of host ${hostKey} is ${row.state}, which a rebind cannot move on from`,
      { host: hostKey, state: row.state },
    );
  }

  if (row.hostID === null) {
    throw new DaemonError(
      'auth_runtime_mismatch',
      `host ${hostKey} never recorded its host ID, so atc cannot rebind it`,
      { host: hostKey, hostName: row.hostName, recordedID: null, actualID: null },
    );
  }

  try {
    await verifyGate(host, row.hostName, binding);

    const found = await verifyCleanupAuthority(host, { name: row.hostName, id: row.hostID });

    if (found === null) {
      throw new BrokerAuthorityError(
        'auth_runtime_mismatch',
        `host ${row.hostName} is gone, so atc cannot rebind it`,
        { hostName: row.hostName, recordedID: row.hostID, actualID: null },
      );
    }
  } catch (error) {
    throw toAuthRefusal(error);
  }

  const revision = row.revision + 1;
  const attemptID = randomUUID();
  const bindingJSON = JSON.stringify(binding);

  await ledger.store.updateAuthBinding(
    hostKey,
    {
      state: 'provisioning',
      rebind: { revision, bindingHash: binding.hash, bindingJSON, attemptID },
    },
    ledger.now(),
  );

  try {
    await applyRebindGrants(ledger, host, { row, binding, revision, attemptID });
  } catch (error) {
    await removeRebindGrants(ledger, host, { hostKey, hostName: row.hostName, attemptID });

    await ledger.store.updateAuthBinding(hostKey, { state: 'rebind_failed' }, ledger.now());

    throw toAuthRefusal(error);
  }

  await ledger.store.updateAuthBinding(
    hostKey,
    {
      state: 'ready',
      revision,
      bindingHash: binding.hash,
      bindingJSON,
      attemptID,
      rebind: null,
    },
    ledger.now(),
  );

  return revision;
}
