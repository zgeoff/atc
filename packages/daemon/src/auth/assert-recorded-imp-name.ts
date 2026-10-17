import type { CredentialBroker } from '@atc/plugin-api';
import type { RuntimeAuthBinding } from '@atc/store';
import { BrokerAuthorityError } from './broker-authority-error';

// Refuses a provider whose name for the host is not the imp the binding
// recorded, such as after the target's imp name prefix changed, so a
// destroy by host key never reaches another imp.
export function assertRecordedImpName(host: CredentialBroker, row: RuntimeAuthBinding): void {
  const name = host.getHostName(row.hostKey);

  if (name !== row.impName) {
    throw new BrokerAuthorityError(
      'auth_runtime_mismatch',
      `host ${row.hostKey} was bound to imp ${row.impName}, but its target now names it ${name}`,
      { imp: row.impName, recordedID: row.impID, actualID: null },
    );
  }
}
