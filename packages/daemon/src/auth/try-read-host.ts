import type { CredentialBroker } from '@atc/plugin-api';
import { toAuthRefusal } from './to-auth-refusal';

export async function tryReadHost(host: CredentialBroker, name: string) {
  try {
    return await host.readHost(name);
  } catch (error) {
    throw toAuthRefusal(error, host);
  }
}
