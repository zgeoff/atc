import type {
  BrokerFeatures,
  BrokerHost,
  BrokerIdentity,
  BrokerSecret,
  BrokerSecretKind,
  BrokerSecretRule,
  CredentialBroker,
} from '@atc/plugin-api';
import { CredentialBrokerError, isHostNameAllowed } from '@atc/plugin-api';

/**
 * An in-memory credential broker that refuses grants as impd does behind
 * the imp provider, for the runtime auth binder's tests. A grant or revoke
 * needs a `manage` identity, a host inside the identity's patterns, and,
 * under patterns, a secret the identity lists as grantable; a secret
 * rebound or removed since the identity was set is no longer grantable.
 * Each refusal rejects with `forbidden`, then a missing host or secret
 * with `not_found`, each with impd's code as the broker code. A rebound or
 * removed secret takes every grant of it with it, a host made again gets a
 * new id, and a destroy of a missing host resolves. `calls` holds every
 * contract call in the order the calls arrive, and a test prepares the
 * broker through the setters as an operator prepares impd. While a test
 * holds the calls, each call is recorded as it arrives and takes effect
 * and answers only on a release, so the calls held at one time are the
 * calls in flight together.
 */
export interface StubBinderBroker extends CredentialBroker {
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

  // Fails every grant removal with an impd code, mapped to an atc code as
  // the imp provider maps it, until called with null.
  readonly setGrantRemovalFailure: (brokerCode: string | null) => void;

  // The names of the hosts the broker holds, in the order it made them.
  readonly collectHostNames: () => string[];

  // The same broker as a provider with another host prefix reaches it.
  readonly buildRenamedBroker: (hostPrefix: string) => CredentialBroker;

  // Holds every call from now until the next release.
  readonly holdCalls: () => void;

  // The calls held since the last release, in the order they arrived.
  readonly collectHeldCalls: () => string[];

  // Resolves to the held calls once at least the count of them are held.
  readonly waitForHeldCalls: (count: number) => Promise<string[]>;

  // Answers every held call in the order they arrived, and holds no more.
  readonly releaseCalls: () => void;
}

interface StubHost {
  readonly id: string;
  readonly grants: Set<string>;
}

export function buildStubBinderBroker(hostPrefix = 'atc-'): StubBinderBroker {
  const calls: string[] = [];

  const hosts = new Map<string, StubHost>();
  const secrets = new Map<string, BrokerSecret>();

  // Grantable secrets rebound or removed since the identity was set.
  const staleGrantable = new Set<string>();

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

  const held: { readonly call: string; readonly answer: () => void }[] = [];
  const heldWaits: { readonly count: number; readonly resolve: (calls: string[]) => void }[] = [];
  let holding = false;
  const collectHeldCalls = () => held.map((entry) => entry.call);

  const emitHeldCalls = (): void => {
    for (const wait of heldWaits.filter((entry) => held.length >= entry.count)) {
      heldWaits.splice(heldWaits.indexOf(wait), 1);
      wait.resolve(collectHeldCalls());
    }
  };

  let removalFailure: string | null = null;
  let nextID = 1;

  const findGrantRefusal = (hostName: string, secret: string): CredentialBrokerError | null => {
    const patterns = identity.hosts;

    if (identity.scope !== 'manage') {
      return new CredentialBrokerError('forbidden', 'the caller cannot manage grants', {
        brokerCode: 'FORBIDDEN',
        data: { reason: 'scope' },
      });
    }

    if (patterns !== null && !isHostNameAllowed(patterns, hostName)) {
      return new CredentialBrokerError(
        'forbidden',
        `host ${hostName} is outside the caller's patterns`,
        { brokerCode: 'FORBIDDEN', data: { reason: 'imp_out_of_scope' } },
      );
    }

    if (patterns !== null && (!identity.grantable.includes(secret) || staleGrantable.has(secret))) {
      return new CredentialBrokerError('forbidden', `the caller cannot grant ${secret}`, {
        brokerCode: 'FORBIDDEN',
        data: { reason: 'not_grantable' },
      });
    }

    if (!hosts.has(hostName)) {
      return buildNotFound('host', hostName);
    }

    if (!secrets.has(secret)) {
      return buildNotFound('secret', secret);
    }

    return null;
  };

  // A secret that is rebound or removed takes every grant of it with it,
  // and no identity set before lists it as grantable any longer.
  const removeGrantsOf = (name: string): void => {
    for (const host of hosts.values()) {
      host.grants.delete(name);
    }

    staleGrantable.add(name);
  };

  // A call's result as the broker answers it: resolved, or rejected with
  // what the call threw, at once or on the release that answers it.
  const answerCall = <T>(call: string, read: () => T): Promise<T> => {
    calls.push(call);

    const answered = Promise.withResolvers<void>();

    if (holding) {
      held.push({ call, answer: answered.resolve });

      emitHeldCalls();
    } else {
      answered.resolve();
    }

    return answered.promise.then(read);
  };

  const buildBroker = (prefix: string): CredentialBroker => {
    const getHostName = (hostKey: string): string => `${prefix}${hostKey}`;

    return {
      hostPrefix: prefix,
      getHostName,
      readFeatures: () => answerCall('readFeatures', () => features),
      readIdentity: () => answerCall('readIdentity', () => identity),
      readSecrets: () => answerCall('readSecrets', () => [...secrets.values()]),
      readGrants: (hostName) =>
        answerCall(`readGrants ${hostName}`, () => {
          const host = hosts.get(hostName);

          if (host === undefined) {
            throw buildNotFound('host', hostName);
          }

          return [...host.grants];
        }),
      createGrant: (hostName, secret) =>
        answerCall(`createGrant ${hostName} ${secret}`, () => {
          const refusal = findGrantRefusal(hostName, secret);

          if (refusal !== null) {
            throw refusal;
          }

          hosts.get(hostName)?.grants.add(secret);
        }),
      removeGrant: (hostName, secret) =>
        answerCall(`removeGrant ${hostName} ${secret}`, () => {
          if (removalFailure !== null) {
            throw new CredentialBrokerError(
              toBrokerCode(removalFailure),
              'impd did not remove the grant',
              { brokerCode: removalFailure },
            );
          }

          const refusal = findGrantRefusal(hostName, secret);

          if (refusal !== null) {
            throw refusal;
          }

          return hosts.get(hostName)?.grants.delete(secret) ?? false;
        }),
      readHost: (hostName) =>
        answerCall(`readHost ${hostName}`, (): BrokerHost | null => {
          const host = hosts.get(hostName);

          return host === undefined ? null : { id: host.id, name: hostName };
        }),
      createHost: (hostKey) =>
        answerCall(`createHost ${getHostName(hostKey)}`, () => {
          const name = getHostName(hostKey);

          if (hosts.has(name)) {
            throw new CredentialBrokerError('refused', `host ${name} already exists`, {
              brokerCode: 'CONFLICT',
              data: { kind: 'imp', name },
            });
          }

          const host = { id: `host-${String(nextID)}`, grants: new Set<string>() };

          nextID += 1;

          hosts.set(name, host);

          return { id: host.id, name };
        }),
      destroyHost: (hostKey) =>
        answerCall(`destroyHost ${getHostName(hostKey)}`, () => {
          hosts.delete(getHostName(hostKey));
        }),
    };
  };

  return {
    ...buildBroker(hostPrefix),
    calls,
    holdCalls: () => {
      holding = true;
    },
    collectHeldCalls,
    waitForHeldCalls: (count) =>
      new Promise((resolve) => {
        heldWaits.push({ count, resolve });

        emitHeldCalls();
      }),
    releaseCalls: () => {
      holding = false;

      for (const entry of held.splice(0)) {
        entry.answer();
      }
    },
    setFeatures: (next) => {
      features = { ...features, ...next };
    },
    setIdentity: (next) => {
      identity = next;

      staleGrantable.clear();
    },
    createSecret: (name, kind, rules) => {
      secrets.set(name, { name, kind, rules });
    },
    updateSecret: (name, rules) => {
      const secret = secrets.get(name);

      if (secret === undefined) {
        throw new Error(`no secret ${name}`);
      }

      secrets.set(name, { ...secret, rules });

      removeGrantsOf(name);
    },
    removeSecret: (name) => {
      secrets.delete(name);

      removeGrantsOf(name);
    },
    setGrantRemovalFailure: (brokerCode) => {
      removalFailure = brokerCode;
    },
    collectHostNames: () => [...hosts.keys()],
    buildRenamedBroker: (prefix) => buildBroker(prefix),
  };
}

function buildNotFound(kind: 'host' | 'secret', name: string): CredentialBrokerError {
  return new CredentialBrokerError('not_found', `no ${kind} ${name}`, {
    brokerCode: 'NOT_FOUND',
    data: { kind, name },
  });
}

// impd's code for a failure as the imp provider maps it to atc's.
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
