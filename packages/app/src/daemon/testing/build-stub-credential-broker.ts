import type {
  BrokerFeatures,
  BrokerIdentity,
  BrokerSecret,
  BrokerSecretKind,
  BrokerSecretRule,
  CredentialBroker,
} from '@atc/plugin-api';
import { CredentialBrokerError } from '@atc/plugin-api';

/**
 * An in-memory credential broker that keeps the broker contract's
 * guarantees: each host it creates gets an id no later host shares, a
 * grant removal the host no longer holds resolves false, and a destroy of
 * a missing host resolves. It enforces no authority itself, so the
 * caller's own checks decide what may run. A test prepares it as an
 * operator prepares a broker, through the setters, and reads `calls` for
 * every contract call in order.
 */
export interface StubCredentialBroker extends CredentialBroker {
  readonly calls: string[];
  readonly setFeatures: (features: Partial<BrokerFeatures>) => void;
  readonly setIdentity: (identity: BrokerIdentity) => void;
  readonly createSecret: (
    name: string,
    kind: BrokerSecretKind,
    rules: readonly BrokerSecretRule[],
  ) => void;
  readonly updateSecret: (name: string, rules: readonly BrokerSecretRule[]) => void;
  readonly removeSecret: (name: string) => void;
}

interface StubHost {
  readonly id: string;
  readonly grants: Set<string>;
}

export function buildStubCredentialBroker(hostPrefix = 'atc-'): StubCredentialBroker {
  const calls: string[] = [];

  const hosts = new Map<string, StubHost>();
  const secrets = new Map<string, BrokerSecret>();

  let features: BrokerFeatures = {
    grantableTokens: true,
    secretRebind: true,
    execRequire: true,
    oauthSecrets: true,
  };

  let identity: BrokerIdentity = {
    name: 'atc-runtime',
    scope: 'manage',
    hosts: [`${hostPrefix}*`],
    grantable: [],
  };

  let nextID = 1;
  const getHostName = (hostKey: string): string => `${hostPrefix}${hostKey}`;

  const getHost = (hostName: string): StubHost => {
    const host = hosts.get(hostName);

    if (host === undefined) {
      throw new CredentialBrokerError('not_found', `no host ${hostName}`, {
        brokerCode: 'NOT_FOUND',
      });
    }

    return host;
  };

  const getSecret = (name: string): BrokerSecret => {
    const secret = secrets.get(name);

    if (secret === undefined) {
      throw new CredentialBrokerError('not_found', `no secret ${name}`, {
        brokerCode: 'NOT_FOUND',
      });
    }

    return secret;
  };

  // A secret that is rebound or removed takes every grant of it with it.
  const removeGrantsOf = (name: string): void => {
    for (const host of hosts.values()) {
      host.grants.delete(name);
    }
  };

  return {
    calls,
    hostPrefix,
    getHostName,
    setFeatures: (next) => {
      features = { ...features, ...next };
    },
    setIdentity: (next) => {
      identity = next;
    },
    createSecret: (name, kind, rules) => {
      secrets.set(name, { name, kind, rules });
    },
    updateSecret: (name, rules) => {
      secrets.set(name, { ...getSecret(name), rules });

      removeGrantsOf(name);
    },
    removeSecret: (name) => {
      secrets.delete(name);

      removeGrantsOf(name);
    },
    readFeatures: () =>
      answerCall(() => {
        calls.push('readFeatures');

        return features;
      }),
    readIdentity: () =>
      answerCall(() => {
        calls.push('readIdentity');

        return identity;
      }),
    readSecrets: () =>
      answerCall(() => {
        calls.push('readSecrets');

        return [...secrets.values()];
      }),
    readGrants: (hostName) =>
      answerCall(() => {
        calls.push(`readGrants ${hostName}`);

        return [...getHost(hostName).grants].toSorted();
      }),
    createGrant: (hostName, secret) =>
      answerCall(() => {
        calls.push(`createGrant ${hostName} ${secret}`);

        const host = getHost(hostName);

        getSecret(secret);

        host.grants.add(secret);
      }),
    removeGrant: (hostName, secret) =>
      answerCall(() => {
        calls.push(`removeGrant ${hostName} ${secret}`);

        const host = getHost(hostName);

        getSecret(secret);

        return host.grants.delete(secret);
      }),
    readHost: (hostName) =>
      answerCall(() => {
        calls.push(`readHost ${hostName}`);

        const host = hosts.get(hostName);

        return host === undefined ? null : { id: host.id, name: hostName };
      }),
    createHost: (hostKey) =>
      answerCall(() => {
        const name = getHostName(hostKey);

        calls.push(`createHost ${name}`);

        if (hosts.has(name)) {
          throw new CredentialBrokerError('refused', `host ${name} already exists`, {
            brokerCode: 'CONFLICT',
          });
        }

        const host = { id: `host-${nextID}`, grants: new Set<string>() };

        nextID += 1;

        hosts.set(name, host);

        return { id: host.id, name };
      }),
    destroyHost: (hostKey) =>
      answerCall(() => {
        const name = getHostName(hostKey);

        calls.push(`destroyHost ${name}`);
        hosts.delete(name);
      }),
  };
}

// A call's result as the broker answers it: resolved, or rejected with
// what the call threw.
function answerCall<T>(read: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(read());
  });
}
