import type { BrokerHost, CredentialBroker } from '@atc/plugin-api';
import { BrokerAuthorityError } from './broker-authority-error';
import { verifyTokenHostAuthority } from './verify-token-host-authority';

// The host a binding recorded when atc made it.
interface RecordedHost {
  readonly name: string;
  readonly id: string;
}

export async function verifyCleanupAuthority(
  broker: Pick<CredentialBroker, 'hostPrefix' | 'readIdentity' | 'readHost'>,
  recorded: RecordedHost,
): Promise<BrokerHost | null> {
  const identity = await broker.readIdentity();

  // Checked first, so the broker's answer for the name comes from a token that
  // can see the host, and a missing host means it is gone.
  verifyTokenHostAuthority(identity, [recorded.name], broker.hostPrefix);

  const found = await broker.readHost(recorded.name);

  if (found !== null && found.id !== recorded.id) {
    throw new BrokerAuthorityError(
      'auth_runtime_mismatch',
      `host ${recorded.name} is no longer the host atc made`,
      { hostName: recorded.name, recordedID: recorded.id, actualID: found.id },
    );
  }

  return found;
}
