import type {
  BrokerIdentity,
  BrokerSecret,
  BrokerSecretKind,
  BrokerSecretRule,
  CredentialBroker,
} from '@atc/plugin-api';
import { CredentialBrokerError } from '@atc/plugin-api';

// enforces no authority itself, so the caller's own checks decide what may run
interface StubCredentialBroker extends CredentialBroker {
  readonly calls: string[];

  // Refuses every version check from now on, as a provider refuses a broker
  // older than the oldest it supports, until called with false.
  readonly setOutdated: (outdated: boolean) => void;
  readonly setIdentity: (identity: BrokerIdentity) => void;

  // Adds a secret, with the sign-in state the broker lists for an `oauth`
  // secret when one is given.
  readonly createSecret: (
    name: string,
    kind: BrokerSecretKind,
    rules: readonly BrokerSecretRule[],
    oauth?: BrokerSecret['oauth'],
  ) => void;
  readonly updateSecret: (name: string, rules: readonly BrokerSecretRule[]) => void;
  readonly removeSecret: (name: string) => void;
}

interface StubHost {
  readonly id: string;
  readonly grants: Set<string>;
}

interface StubFailingCredentialBroker extends StubCredentialBroker {
  // Fails the next version checks as an unreachable broker, before they
  // answer.
  readonly setVersionFailures: (count: number) => void;
}

export function buildStubCredentialBroker(hostPrefix = 'atc-'): StubFailingCredentialBroker {
  const calls: string[] = [];

  const hosts = new Map<string, StubHost>();
  const secrets = new Map<string, BrokerSecret>();

  let outdated = false;

  let identity: BrokerIdentity = {
    name: 'atc-runtime',
    scope: 'manage',
    hosts: [`${hostPrefix}*`],
    grantable: [],
  };

  let versionFailures = 0;
  let nextID = 1;
  const getHostName = (hostKey: string): string => `${hostPrefix}${hostKey}`;

  const getHost = (hostName: string): StubHost => {
    const host = hosts.get(hostName);

    if (host === undefined) {
      throw new CredentialBrokerError('not_found', `no host ${hostName}`, {
        provider: 'stub-remote',
        brokerCode: 'NOT_FOUND',
      });
    }

    return host;
  };

  const getSecret = (name: string): BrokerSecret => {
    const secret = secrets.get(name);

    if (secret === undefined) {
      throw new CredentialBrokerError('not_found', `no secret ${name}`, {
        provider: 'stub-remote',
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
    setOutdated: (next) => {
      outdated = next;
    },
    setIdentity: (next) => {
      identity = next;
    },
    setVersionFailures: (count) => {
      versionFailures = count;
    },
    createSecret: (name, kind, rules, oauth) => {
      const secret: BrokerSecret =
        oauth === undefined ? { name, kind, rules } : { name, kind, rules, oauth };

      secrets.set(name, secret);
    },
    updateSecret: (name, rules) => {
      secrets.set(name, { ...getSecret(name), rules });

      removeGrantsOf(name);
    },
    removeSecret: (name) => {
      secrets.delete(name);

      removeGrantsOf(name);
    },
    verifyVersion: () =>
      answerCall(() => {
        calls.push('verifyVersion');

        if (versionFailures > 0) {
          versionFailures -= 1;

          throw new CredentialBrokerError('unreachable', 'the broker did not answer', {
            provider: 'stub-remote',
            brokerCode: 'UNREACHABLE',
          });
        }

        if (outdated) {
          throw new CredentialBrokerError(
            'refused',
            'the broker is older than the oldest this atc supports',
            { provider: 'stub-remote', brokerCode: 'IMPD_OUTDATED' },
          );
        }
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
            provider: 'stub-remote',
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
