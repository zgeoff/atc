import type { CredentialBroker } from '@atc/plugin-api';
import { toAuthRefusal } from './to-auth-refusal';

export async function tryReadGrants(
  host: CredentialBroker,
  name: string,
): Promise<readonly string[]> {
  try {
    return await host.readGrants(name);
  } catch (error) {
    throw toAuthRefusal(error);
  }
}
