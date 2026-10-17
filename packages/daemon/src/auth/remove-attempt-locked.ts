import type { SessionID } from '@atc/core';
import type { CredentialBroker } from '@atc/plugin-api';
import { EffectRemainsError } from '@atc/plugin-api';
import { assertRecordedImpName } from './assert-recorded-imp-name';
import { formatError } from './format-error';
import type { RuntimeAuthLedger } from './runtime-auth-ledger';
import { tryReadImp } from './try-read-imp';
import { verifyCleanupAuthority } from './verify-cleanup-authority';

// Takes back a spawn attempt's imp and binding under the host's lock, which
// the caller holds.
export async function removeAttemptLocked(
  ledger: RuntimeAuthLedger,
  host: CredentialBroker,
  hostKey: SessionID,
  attemptID: string,
): Promise<void> {
  const row = await ledger.store.findAuthBinding(hostKey);

  if (row === null || row.attemptID !== attemptID || row.rebind !== null) {
    return;
  }

  try {
    if (row.impID === null || !row.impCreatedByAttempt) {
      // Nothing this attempt made carries an id, so only an empty name
      // lets the record go.
      if ((await tryReadImp(host, row.impName)) !== null) {
        throw new Error(
          `imp ${row.impName} exists, and nothing shows this attempt created it; reconcile it by hand`,
        );
      }
    } else {
      assertRecordedImpName(host, row);

      const imp = await verifyCleanupAuthority(host, { name: row.impName, id: row.impID });

      if (imp !== null) {
        await host.destroyHost(hostKey);
      }

      if ((await tryReadImp(host, row.impName)) !== null) {
        throw new Error(`imp ${row.impName} is still listed after its destroy`);
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
