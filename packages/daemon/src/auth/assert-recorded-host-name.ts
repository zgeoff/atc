import type { CredentialBroker } from '@atc/plugin-api';
import type { RuntimeAuthBinding } from '@atc/store';
import { BrokerAuthorityError } from './broker-authority-error';

// Refuses a provider whose name for the host is not the host the binding
// recorded, such as after the target's host name prefix changed, so a
// destroy by host key never reaches another host.
export function assertRecordedHostName(host: CredentialBroker, row: RuntimeAuthBinding): void {
  const name = host.getHostName(row.hostKey);

  if (name !== row.hostName) {
    throw new BrokerAuthorityError(
      'auth_runtime_mismatch',
      `host ${row.hostKey} was bound to host ${row.hostName}, but its target now names it ${name}`,
      { hostName: row.hostName, recordedID: row.hostID, actualID: null },
    );
  }
}
