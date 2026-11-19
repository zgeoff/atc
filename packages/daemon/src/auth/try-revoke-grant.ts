import type { CredentialBroker } from '@atc/plugin-api';
import { CredentialBrokerError } from '@atc/plugin-api';

export async function tryRevokeGrant(
  host: CredentialBroker,
  hostName: string,
  secret: string,
): Promise<boolean> {
  try {
    await host.removeGrant(hostName, secret);

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
    const held = await host.readGrants(hostName);

    return !held.includes(secret);
  } catch (error) {
    return error instanceof CredentialBrokerError && error.code === 'not_found';
  }
}
