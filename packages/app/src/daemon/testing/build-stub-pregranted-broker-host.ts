import type { CredentialBroker } from '@atc/plugin-api';

/**
 * A credential broker whose new hosts already hold a grant of `secret` when its
 * create returns, as on a broker where another principal grants every host
 * the moment it appears. Every other member is the given broker's own.
 */
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
