import { isHostNameAllowed } from '@atc/plugin-api';
import { buildImpdRefusal } from '../build-impd-refusal';
import type { ImpIdentity, ImpSecret, ImpSecretRule } from '../imp-port';
import { ImpPortError } from '../imp-port-error';
import type { ImpdBareRefusalCode, ImpdOutput } from '../impd-contract';
import { toImpIdentity } from '../to-imp-identity';
import { toImpSecret } from '../to-imp-secret';
import type { ImpdListedSecret } from '../to-imp-secret';
import { buildNotFound } from './build-not-found';
import type { StubImpFleet } from './stub-imp-fleet';

interface StubImpSecretsOptions {
  readonly calls: string[];
  readonly fleet: StubImpFleet;
}

// The secrets impd holds, the grants of them to imps, and the identity the
// port calls impd as, which decides what it may grant.
export class StubImpSecrets {
  // Who the port calls impd as.
  private identity: ImpIdentity = {
    kind: 'token',
    name: 'atc',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: [],
  };

  // Grantable secrets rebound or removed since the identity was set, which
  // its list no longer covers, as a secret's new generation leaves a
  // token's list behind.
  private readonly staleGrantable = new Set<string>();

  // The secrets impd holds, by name; which imps hold each is the grants'.
  private readonly secrets = new Map<string, Omit<ImpSecret, 'imps'>>();

  // impd's code for every grant removal while removals fail, or null.
  private grantRemovalFailure: ImpdBareRefusalCode<'grants.delete'> | 'UNREACHABLE' | null = null;

  private readonly calls: string[];

  private readonly fleet: StubImpFleet;

  constructor(deps: StubImpSecretsOptions) {
    this.calls = deps.calls;
    this.fleet = deps.fleet;
  }

  readIdentity(): Promise<ImpIdentity> {
    this.calls.push('tokens.whoami');

    const identity = this.identity;

    return Promise.resolve(
      toImpIdentity({
        kind: identity.kind,
        name: identity.name,
        scope: identity.scope,
        imps: identity.imps,
        grantable: identity.grantable,
      }),
    );
  }

  readSecrets(): Promise<readonly ImpSecret[]> {
    this.calls.push('secrets.list');

    return Promise.resolve(
      [...this.secrets.values()].map((secret) => {
        const imps = [...this.fleet.imps.values()]
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
  }

  readGrants(name: string): Promise<readonly string[]> {
    this.calls.push(`grants.list ${name}`);

    const imp = this.fleet.imps.get(name);

    if (imp === undefined) {
      return Promise.reject(buildNotFound('grants.list', name));
    }

    const grants: ImpdOutput<'grants.list'> = [...imp.grants];

    return Promise.resolve(grants);
  }

  createGrant(name: string, secret: string): Promise<void> {
    this.calls.push(`grants.add ${name} ${secret}`);

    const refusal = this.findGrantRefusal(name, secret);

    if (refusal !== null) {
      return Promise.reject(refusal);
    }

    const imp = this.fleet.getImp(name);

    const hosts = new Set(this.secrets.get(secret)?.rules.map((rule) => rule.host));

    const clash = [...imp.grants].find(
      (held) =>
        held !== secret &&
        (this.secrets.get(held)?.rules ?? []).some((rule) => hosts.has(rule.host)),
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
  }

  removeGrant(name: string, secret: string): Promise<boolean> {
    this.calls.push(`grants.delete ${name} ${secret}`);

    if (this.grantRemovalFailure !== null) {
      return Promise.reject(
        new ImpPortError(this.grantRemovalFailure, 'impd did not remove the grant'),
      );
    }

    const refusal = this.findGrantRefusal(name, secret);

    if (refusal !== null) {
      return Promise.reject(refusal);
    }

    return Promise.resolve(this.fleet.getImp(name).grants.delete(secret));
  }

  // A new token's grantable list covers each secret as it now stands.
  setIdentity(identity: ImpIdentity): void {
    this.identity = identity;

    this.staleGrantable.clear();
  }

  createSecret(
    name: string,
    kind: ImpSecret['kind'],
    rules: readonly ImpSecretRule[],
    oauth?: ImpSecret['oauth'],
  ): void {
    this.secrets.set(name, { name, kind, rules, ...(oauth === undefined ? {} : { oauth }) });
  }

  // As a rebind does, no token's grantable list covers the secret any longer.
  updateSecret(name: string, rules: readonly ImpSecretRule[]): void {
    const secret = this.secrets.get(name);

    if (secret === undefined) {
      throw new Error(`no secret ${name}`);
    }

    this.secrets.set(name, { ...secret, rules });
    this.removeGrants(name);
    this.staleGrantable.add(name);
  }

  removeSecret(name: string): void {
    this.secrets.delete(name);
    this.removeGrants(name);
    this.staleGrantable.add(name);
  }

  setGrantRemovalFailure(code: ImpdBareRefusalCode<'grants.delete'> | 'UNREACHABLE' | null): void {
    this.grantRemovalFailure = code;
  }

  // impd's refusal of a grant or revoke: the scope and pattern checks run
  // before anything is looked up, then a missing imp or secret.
  private findGrantRefusal(name: string, secret: string): ImpPortError | null {
    const identity = this.identity;
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

    if (
      patterns !== null &&
      (!identity.grantable.includes(secret) || this.staleGrantable.has(secret))
    ) {
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

    if (!this.fleet.imps.has(name)) {
      return buildNotFound('grants.add', name);
    }

    if (!this.secrets.has(secret)) {
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
  }

  private removeGrants(secret: string): void {
    for (const imp of this.fleet.imps.values()) {
      imp.grants.delete(secret);
    }
  }
}
