import type { BrokerHost, CredentialBroker } from '@atc/plugin-api';
import { BrokerAuthorityError } from './broker-authority-error';
import { verifyTokenImpAuthority } from './verify-token-imp-authority';

// The imp a binding recorded when atc made it.
interface RecordedImp {
  readonly name: string;
  readonly id: string;
}

export async function verifyCleanupAuthority(
  broker: Pick<CredentialBroker, 'hostPrefix' | 'readIdentity' | 'readHost'>,
  recorded: RecordedImp,
): Promise<BrokerHost | null> {
  const identity = await broker.readIdentity();

  // Checked first, so impd's answer for the name comes from a token that
  // can see the imp, and a missing imp means it is gone.
  verifyTokenImpAuthority(identity, [recorded.name], broker.hostPrefix);

  const imp = await broker.readHost(recorded.name);

  if (imp !== null && imp.id !== recorded.id) {
    throw new BrokerAuthorityError(
      'auth_runtime_mismatch',
      `imp ${recorded.name} is no longer the imp atc made`,
      { imp: recorded.name, recordedID: recorded.id, actualID: imp.id },
    );
  }

  return imp;
}
