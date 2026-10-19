import type { SessionID } from '@atc/core';
import type { CredentialBroker } from '@atc/plugin-api';
import { EffectRemainsError } from '@atc/plugin-api';
import { assertRecordedHostName } from './assert-recorded-host-name';
import { formatError } from './format-error';
import type { RuntimeAuthLedger } from './runtime-auth-ledger';
import { tryReadHost } from './try-read-host';
import { verifyCleanupAuthority } from './verify-cleanup-authority';

// Takes back a spawn attempt's host and binding under the host's lock, which
// the caller holds.
export async function removeAttemptLocked(
  ledger: RuntimeAuthLedger,
  host: CredentialBroker,
  hostKey: SessionID,
  attemptID: string,
): Promise<void> {
  const row = await ledger.store.readAuthBinding(hostKey);

  if (row === null || row.attemptID !== attemptID || row.rebind !== null) {
    return;
  }

  try {
    if (row.hostID === null || !row.hostCreatedByAttempt) {
      // Nothing this attempt made carries an id, so only an empty name
      // lets the record go.
      if ((await tryReadHost(host, row.hostName)) !== null) {
        throw new Error(
          `host ${row.hostName} exists, and nothing shows this attempt created it; reconcile it by hand`,
        );
      }
    } else {
      assertRecordedHostName(host, row);

      const created = await verifyCleanupAuthority(host, { name: row.hostName, id: row.hostID });

      if (created !== null) {
        await host.destroyHost(hostKey);
      }

      if ((await tryReadHost(host, row.hostName)) !== null) {
        throw new Error(`host ${row.hostName} is still listed after its destroy`);
      }
    }
  } catch (error) {
    await ledger.store.updateAuthBinding(hostKey, { state: 'rollback_pending' }, ledger.now());

    throw new EffectRemainsError(
      `atc could not take back the runtime auth of host ${hostKey} (${formatError(error)})`,
      { cause: error },
    );
  }

  await ledger.store.removeAuthBinding(hostKey);
}
