import type { CredentialBroker } from '@atc/plugin-api';

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
