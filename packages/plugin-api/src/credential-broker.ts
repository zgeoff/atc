/**
 * A credential broker that a provider's hosts can reach: it holds secrets,
 * grants them to hosts, and adds them to a host's requests on the host's
 * side, so the harness never holds the credential. The daemon's runtime
 * auth decides what to grant and checks the broker's authority; the
 * provider only answers these calls.
 *
 * The daemon relies on three guarantees:
 *
 * - A host's id proves which host atc made. A host made again under the
 *   same name never takes the old id, so a host whose id differs from the
 *   recorded one is another host, which atc never grants to or destroys.
 * - Grant cleanup is idempotent. Removing a grant the host no longer holds
 *   changes nothing and resolves false, so a cleanup that runs twice ends
 *   in the same state as one that runs once.
 * - Destroying a host the broker no longer holds counts as done and
 *   resolves.
 *
 * Every call that the broker refuses or cannot serve rejects with a broker
 * error, which holds an atc code and the broker's own.
 */
export interface CredentialBroker {
  // The literal start of every host name this provider builds. The
  // provider owns a host name when the name starts with it.
  readonly hostPrefix: string;

  // The name of the host a host key runs on.
  readonly getHostName: (hostKey: string) => string;

  // What the broker supports.
  readonly readFeatures: () => Promise<BrokerFeatures>;

  // The provider's own identity: its scope, the hosts it may reach, and the
  // secrets it may grant.
  readonly readIdentity: () => Promise<BrokerIdentity>;

  // Every secret the broker holds, with its rules and never its value.
  readonly readSecrets: () => Promise<readonly BrokerSecret[]>;

  // The names of the secrets granted to a host.
  readonly readGrants: (hostName: string) => Promise<readonly string[]>;

  // Grants a secret to a host. Granting a secret the host already holds
  // changes nothing, and the result never tells a new grant from an old one.
  readonly createGrant: (hostName: string, secret: string) => Promise<void>;

  // Revokes a secret from a host, and resolves whether the host held it.
  // A host or secret that is gone rejects with `not_found`, and the grant
  // is gone with it.
  readonly removeGrant: (hostName: string, secret: string) => Promise<boolean>;

  // The host under a name, or null when the broker holds none.
  readonly readHost: (hostName: string) => Promise<BrokerHost | null>;

  // Creates the host a host key runs on, as the provider itself creates it.
  readonly createHost: (hostKey: string) => Promise<BrokerHost>;

  // Destroys the host a host key runs on, as the provider itself destroys
  // it. A host that is already gone counts as destroyed.
  readonly destroyHost: (hostKey: string) => Promise<void>;
}

/**
 * The broker features runtime auth depends on: tokens that may grant a
 * list of secrets, grants that a rebound secret drops, starts that wait for
 * the broker, and secrets whose access token the broker renews.
 */
export interface BrokerFeatures {
  readonly grantableTokens: boolean;
  readonly secretRebind: boolean;
  readonly execRequire: boolean;
  readonly oauthSecrets: boolean;
}

/**
 * Who the provider is to the broker. `hosts` holds host name patterns, each
 * a host name with `*` for any run of characters, or null when the identity
 * reaches every host.
 */
export interface BrokerIdentity {
  readonly name: string;
  readonly scope: 'read' | 'exec' | 'manage';
  readonly hosts: readonly string[] | null;

  // The secrets the identity may grant to the hosts it reaches and revoke
  // from them.
  readonly grantable: readonly string[];
}

/**
 * One secret the broker holds. `oauth` holds the sign-in state of a secret
 * of kind `oauth` and is absent for any other kind.
 */
export interface BrokerSecret {
  readonly name: string;
  readonly kind: BrokerSecretKind;
  readonly rules: readonly BrokerSecretRule[];
  readonly oauth?: BrokerOAuthState;
}

export type BrokerSecretKind = 'anthropic' | 'custom' | 'github' | 'npm' | 'oauth';

// How the broker adds a secret to requests for one host.
export interface BrokerSecretRule {
  readonly host: string;
  readonly header: string;
  readonly scheme: 'basic' | 'bearer' | 'raw';
  readonly user?: string;
}

/**
 * Where an `oauth` secret's sign-in stands: `ready` while the broker holds
 * an access token, `pending` until a refresh first works, and `needs_login`
 * once the token endpoint refused the refresh token for good. `idClaims`
 * holds the payload of the last ID token, or null before the broker has one.
 */
interface BrokerOAuthState {
  readonly status: 'pending' | 'ready' | 'needs_login';
  readonly idClaims: Readonly<Record<string, unknown>> | null;
}

/**
 * A host as the broker holds it: the id that a host made again under the
 * same name never shares, and its name.
 */
export interface BrokerHost {
  readonly id: string;
  readonly name: string;
}
