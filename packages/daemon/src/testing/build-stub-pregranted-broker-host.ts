import type { CredentialBroker } from '@atc/plugin-api';

// as on a broker where another principal grants every host the moment it appears
export function buildStubPregrantedBrokerHost(
  host: CredentialBroker,
  secret: string,
): CredentialBroker {
  return {
    ...host,
    createHost: async (hostKey) => {
      const created = await host.createHost(hostKey);

      await host.createGrant(created.name, secret);

      return created;
    },
  };
}
