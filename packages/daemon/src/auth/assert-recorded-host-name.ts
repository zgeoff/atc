import type { CredentialBroker } from '@atc/plugin-api';
import type { RuntimeAuthBinding } from '@atc/store';
import { BrokerAuthorityError } from './broker-authority-error';

// A changed host name prefix on the target can make a host key point at a different host.
// Destroying by host key would then reach the wrong host.
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
