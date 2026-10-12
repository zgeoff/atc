import type { BrokerHost, CredentialBroker } from '@atc/plugin-api/credential-broker';
import { BrokerAuthorityError } from './broker-authority-error';
import { verifyTokenImpAuthority } from './verify-token-imp-authority';

// The imp a binding recorded when atc made it.
interface RecordedImp {
  readonly name: string;
  readonly id: string;
}

/**
 * The check before atc destroys a session's imp or revokes its grants.
 * It asks that the token may manage the recorded imp, under imp patterns
 * that stay inside the namespace whose imp names start with the prefix,
 * and that the imp under that
 * name is still the one recorded. It never asks that a secret's rules
 * still match or that every grant is still in place, so a rotated, rebound
 * or deleted secret never stops atc removing access. Resolves to the imp,
 * or to null when impd confirms no imp holds the name, which needs no
 * cleanup; an imp with another id rejects.
 */
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
