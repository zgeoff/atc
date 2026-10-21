import { isHostNameAllowed } from '@atc/plugin-api';
import { buildImpdRefusal } from '../build-impd-refusal';
import type { ImpIdentity, ImpSecret, ImpSecretRule } from '../imp-port';
import { ImpPortError } from '../imp-port-error';
import type { ImpdBareRefusalCode, ImpdOutput } from '../impd-contract';
import { toImpIdentity } from '../to-imp-identity';
import { toImpSecret } from '../to-imp-secret';
import type { ImpdListedSecret } from '../to-imp-secret';
import { buildNotFound } from './build-not-found';
import type { StubImpFleet } from './create-stub-imp-fleet';

// The secrets impd holds, the grants of them to imps, and the identity the
// port calls impd as, which decides what it may grant.
export interface StubImpSecrets {
  readonly readIdentity: () => Promise<ImpIdentity>;
  readonly readSecrets: () => Promise<readonly ImpSecret[]>;
  readonly readGrants: (name: string) => Promise<readonly string[]>;
  readonly createGrant: (name: string, secret: string) => Promise<void>;
  readonly removeGrant: (name: string, secret: string) => Promise<boolean>;

  // A new token's grantable list covers each secret as it now stands.
  readonly setIdentity: (identity: ImpIdentity) => void;

  readonly createSecret: (
    name: string,
    kind: ImpSecret['kind'],
    rules: readonly ImpSecretRule[],
    oauth?: ImpSecret['oauth'],
  ) => void;

  // As a rebind does, no token's grantable list covers the secret any longer.
  readonly updateSecret: (name: string, rules: readonly ImpSecretRule[]) => void;

  readonly removeSecret: (name: string) => void;
  readonly setGrantRemovalFailure: (
    code: ImpdBareRefusalCode<'grants.delete'> | 'UNREACHABLE' | null,
  ) => void;
}

interface StubImpSecretsOptions {
  readonly calls: string[];
  readonly fleet: StubImpFleet;
}

export function createStubImpSecrets(deps: StubImpSecretsOptions): StubImpSecrets {
  // Who the port calls impd as.
  let identity: ImpIdentity = {
    kind: 'token',
    name: 'atc',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: [],
  };

  // Grantable secrets rebound or removed since the identity was set, which
  // its list no longer covers, as a secret's new generation leaves a
  // token's list behind.
  const staleGrantable = new Set<string>();

  // The secrets impd holds, by name; which imps hold each is the grants'.
  const secrets = new Map<string, Omit<ImpSecret, 'imps'>>();

  // impd's code for every grant removal while removals fail, or null.
  let grantRemovalFailure: ImpdBareRefusalCode<'grants.delete'> | 'UNREACHABLE' | null = null;
  const calls = deps.calls;
  const fleet = deps.fleet;

  // impd's refusal of a grant or revoke: the scope and pattern checks run
  // before anything is looked up, then a missing imp or secret.
  const findGrantRefusal = (name: string, secret: string): ImpPortError | null => {
    const patterns = identity.imps;

    if (identity.scope !== 'manage') {
      return buildImpdRefusal(
        'grants.add',
        {
          code: 'FORBIDDEN',
          data: {
            reason: 'scope',
          },
        },
        'the caller cannot manage grants',
      );
    }

    if (patterns !== null && !isHostNameAllowed(patterns, name)) {
      return buildImpdRefusal(
        'grants.add',
        { code: 'FORBIDDEN', data: { reason: 'imp_out_of_scope' } },
        `imp ${name} is outside the caller's patterns`,
      );
    }

    if (patterns !== null && (!identity.grantable.includes(secret) || staleGrantable.has(secret))) {
      return buildImpdRefusal(
        'grants.add',
        {
          code: 'FORBIDDEN',
          data: {
            reason: 'not_grantable',
          },
        },
        `the caller cannot grant ${secret}`,
      );
    }

    if (!fleet.imps.has(name)) {
      return buildNotFound('grants.add', name);
    }

    if (!secrets.has(secret)) {
      return buildImpdRefusal(
        'grants.add',
        {
          code: 'NOT_FOUND',
          data: {
            kind: 'secret',
            name: secret,
          },
        },
        `no secret ${secret}`,
      );
    }

    return null;
  };

  const removeGrants = (secret: string): void => {
    for (const imp of fleet.imps.values()) {
      imp.grants.delete(secret);
    }
  };

  return {
    readIdentity: () => {
      calls.push('tokens.whoami');

      return Promise.resolve(
        toImpIdentity({
          kind: identity.kind,
          name: identity.name,
          scope: identity.scope,
          imps: identity.imps,
          grantable: identity.grantable,
        }),
      );
    },

    readSecrets: () => {
      calls.push('secrets.list');

      return Promise.resolve(
        [...secrets.values()].map((secret) => {
          const imps = [...fleet.imps.values()]
            .filter((imp) => imp.grants.has(secret.name))
            .map((imp) => imp.name);

          const listed: ImpdListedSecret = {
            name: secret.name,
            kind: secret.kind,
            rules: secret.rules.map((rule) => ({
              host: rule.host,
              header: rule.header,
              scheme: rule.scheme,
              ...(rule.user === undefined ? {} : { user: rule.user }),
            })),
            imps,
            ...(secret.oauth === undefined
              ? {}
              : { oauth: { status: secret.oauth.status, idClaims: secret.oauth.idClaims } }),
          };

          return toImpSecret(listed);
        }),
      );
    },

    readGrants: (name) => {
      calls.push(`grants.list ${name}`);

      const imp = fleet.imps.get(name);

      if (imp === undefined) {
        return Promise.reject(buildNotFound('grants.list', name));
      }

      const grants: ImpdOutput<'grants.list'> = [...imp.grants];

      return Promise.resolve(grants);
    },

    createGrant: (name, secret) => {
      calls.push(`grants.add ${name} ${secret}`);

      const refusal = findGrantRefusal(name, secret);

      if (refusal !== null) {
        return Promise.reject(refusal);
      }

      const imp = fleet.getImp(name);

      const hosts = new Set(secrets.get(secret)?.rules.map((rule) => rule.host));

      const clash = [...imp.grants].find(
        (held) =>
          held !== secret && (secrets.get(held)?.rules ?? []).some((rule) => hosts.has(rule.host)),
      );

      if (clash !== undefined) {
        return Promise.reject(
          buildImpdRefusal(
            'grants.add',
            {
              code: 'CONFLICT',
              data: {
                kind: 'grant',
                name: `${name}/${clash}`,
              },
            },
            `grant ${clash} covers a host of ${secret}`,
          ),
        );
      }

      imp.grants.add(secret);

      return Promise.resolve();
    },

    removeGrant: (name, secret) => {
      calls.push(`grants.delete ${name} ${secret}`);

      if (grantRemovalFailure !== null) {
        return Promise.reject(
          new ImpPortError(grantRemovalFailure, 'impd did not remove the grant'),
        );
      }

      const refusal = findGrantRefusal(name, secret);

      if (refusal !== null) {
        return Promise.reject(refusal);
      }

      return Promise.resolve(fleet.getImp(name).grants.delete(secret));
    },

    setIdentity: (next) => {
      identity = next;

      staleGrantable.clear();
    },

    createSecret: (name, kind, rules, oauth) => {
      secrets.set(name, { name, kind, rules, ...(oauth === undefined ? {} : { oauth }) });
    },

    updateSecret: (name, rules) => {
      const secret = secrets.get(name);

      if (secret === undefined) {
        throw new Error(`no secret ${name}`);
      }

      secrets.set(name, { ...secret, rules });

      removeGrants(name);

      staleGrantable.add(name);
    },

    removeSecret: (name) => {
      secrets.delete(name);

      removeGrants(name);

      staleGrantable.add(name);
    },

    setGrantRemovalFailure: (code) => {
      grantRemovalFailure = code;
    },
  };
}
