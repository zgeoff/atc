import type { CredentialBroker } from '@atc/plugin-api';
import { CredentialBrokerError } from '@atc/plugin-api';

// Whether a grant is gone: revoked now, already gone, its imp or secret
// gone, or, when impd forbids the revoke, absent from the imp's grants.
export async function tryRevokeGrant(
  host: CredentialBroker,
  impName: string,
  secret: string,
): Promise<boolean> {
  try {
    await host.removeGrant(impName, secret);

    return true;
  } catch (error) {
    if (error instanceof CredentialBrokerError && error.code === 'not_found') {
      return true;
    }

    if (!(error instanceof CredentialBrokerError && error.code === 'forbidden')) {
      return false;
    }
  }

  try {
    const held = await host.readGrants(impName);

    return !held.includes(secret);
  } catch (error) {
    return error instanceof CredentialBrokerError && error.code === 'not_found';
  }
}
