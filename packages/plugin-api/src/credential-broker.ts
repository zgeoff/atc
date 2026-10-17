// every call the broker refuses or cannot serve rejects with a broker error.
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

export interface BrokerFeatures {
  // tokens that may grant a list of secrets.
  readonly grantableTokens: boolean;

  // grants that a rebound secret drops.
  readonly secretRebind: boolean;

  // starts that wait for the broker.
  readonly execRequire: boolean;

  // secrets whose access token the broker renews.
  readonly oauthSecrets: boolean;
}

export interface BrokerIdentity {
  readonly name: string;
  readonly scope: 'read' | 'exec' | 'manage';

  // host name patterns, `*` matching any run of characters; null when the
  // identity reaches every host.
  readonly hosts: readonly string[] | null;

  // The secrets the identity may grant to the hosts it reaches and revoke
  // from them.
  readonly grantable: readonly string[];
}

export interface BrokerSecret {
  readonly name: string;
  readonly kind: BrokerSecretKind;
  readonly rules: readonly BrokerSecretRule[];

  // present only for a secret of kind `oauth`.
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

interface BrokerOAuthState {
  // `pending` until a refresh first works; `needs_login` once the token
  // endpoint refused the refresh token for good.
  readonly status: 'pending' | 'ready' | 'needs_login';

  // the payload of the last ID token, or null before the broker has one.
  readonly idClaims: Readonly<Record<string, unknown>> | null;
}

export interface BrokerHost {
  // a host made again under the same name never shares this id.
  readonly id: string;
  readonly name: string;
}
