import type { BrokerAuthHost } from '../daemon/broker-auth-host';

/**
 * A broker host whose new imps already hold a grant of `secret` when its
 * create returns, as on an impd where another principal grants every imp
 * the moment it appears. Every other member is the given host's own.
 */
export function buildStubPregrantedBrokerHost(
  host: BrokerAuthHost,
  secret: string,
): BrokerAuthHost {
  return {
    ...host,
    createImp: async (hostKey) => {
      const imp = await host.createImp(hostKey);

      await host.port.createGrant(imp.name, secret);

      return imp;
    },
  };
}
