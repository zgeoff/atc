import type { BrokerSecret, CredentialBroker } from '@atc/plugin-api';
import { CredentialBrokerError } from '@atc/plugin-api';
import type { ImpPort, ImpSecret, ImpView } from './imp-port';
import { ImpPortError } from './imp-port-error';

interface ImpBrokerHosts {
  readonly impPrefix: string;
  readonly getImpName: (hostKey: string) => string;
  readonly createImp: (hostKey: string) => Promise<ImpView>;
  readonly destroyImp: (hostKey: string) => Promise<void>;
}

export function buildImpCredentialBroker(port: ImpPort, hosts: ImpBrokerHosts): CredentialBroker {
  return {
    hostPrefix: hosts.impPrefix,
    getHostName: hosts.getImpName,
    verifyVersion: () => withBrokerErrors(() => port.verifyVersion()),
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
        provider: 'imp',
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
