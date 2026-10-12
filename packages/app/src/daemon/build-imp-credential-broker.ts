import type { BrokerSecret, CredentialBroker } from '@atc/plugin-api/credential-broker';
import { CredentialBrokerError } from '@atc/plugin-api/credential-broker-error';
import type { ImpPort, ImpSecret, ImpView } from './imp-port';
import { ImpPortError } from './imp-port-error';

/**
 * How the imp provider creates and destroys the imp a host key runs on,
 * and the imp names it builds.
 */
interface ImpBrokerHosts {
  readonly impPrefix: string;
  readonly getImpName: (hostKey: string) => string;
  readonly createImp: (hostKey: string) => Promise<ImpView>;
  readonly destroyImp: (hostKey: string) => Promise<void>;
}

/**
 * impd's credential broker in atc's terms: each host is an imp, and each
 * impd refusal rejects as a broker error that keeps impd's code. A destroy
 * the provider makes of a missing imp counts as done.
 */
export function buildImpCredentialBroker(port: ImpPort, hosts: ImpBrokerHosts): CredentialBroker {
  return {
    hostPrefix: hosts.impPrefix,
    getHostName: hosts.getImpName,
    readFeatures: () => withBrokerErrors(() => port.readFeatures()),
    readIdentity: () =>
      withBrokerErrors(async () => {
        const identity = await port.readIdentity();

        return {
          name: identity.name,
          scope: identity.scope,
          hosts: identity.imps,
          grantable: identity.grantable,
        };
      }),
    readSecrets: () =>
      withBrokerErrors(async () => {
        const secrets = await port.readSecrets();

        return secrets.map((secret) => toBrokerSecret(secret));
      }),
    readGrants: (hostName) => withBrokerErrors(() => port.readGrants(hostName)),
    createGrant: (hostName, secret) => withBrokerErrors(() => port.createGrant(hostName, secret)),
    removeGrant: (hostName, secret) => withBrokerErrors(() => port.removeGrant(hostName, secret)),
    readHost: (hostName) =>
      withBrokerErrors(async () => {
        const imp = await port.readImp(hostName);

        return imp === null ? null : { id: imp.id, name: imp.name };
      }),
    createHost: (hostKey) =>
      withBrokerErrors(async () => {
        const imp = await hosts.createImp(hostKey);

        return { id: imp.id, name: imp.name };
      }),
    destroyHost: (hostKey) => withBrokerErrors(() => hosts.destroyImp(hostKey)),
  };
}

function toBrokerSecret(secret: ImpSecret): BrokerSecret {
  const listed = { name: secret.name, kind: secret.kind, rules: secret.rules };

  return secret.oauth === undefined ? listed : { ...listed, oauth: secret.oauth };
}

async function withBrokerErrors<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ImpPortError) {
      throw new CredentialBrokerError(toBrokerCode(error.code), error.message, {
        brokerCode: error.code,
        data: error.data,
      });
    }

    throw error;
  }
}

function toBrokerCode(code: string): CredentialBrokerError['code'] {
  switch (code) {
    case 'NOT_FOUND': {
      return 'not_found';
    }
    case 'FORBIDDEN': {
      return 'forbidden';
    }
    case 'UNAUTHORIZED': {
      return 'unauthorized';
    }
    case 'UNREACHABLE': {
      return 'unreachable';
    }
    default: {
      return 'refused';
    }
  }
}
