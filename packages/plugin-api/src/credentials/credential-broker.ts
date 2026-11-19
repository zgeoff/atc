export interface CredentialBroker {
  readonly hostPrefix: string;

  readonly getHostName: (hostKey: string) => string;

  readonly describe: {
    readonly name: string;
    readonly renewSecret?: (secret: string, kind: BrokerSecretKind) => string;
    readonly upgrade?: string;
  };

  readonly verifyVersion: () => Promise<void>;

  readonly readIdentity: () => Promise<BrokerIdentity>;

  readonly readSecrets: () => Promise<readonly BrokerSecret[]>;

  readonly readGrants: (hostName: string) => Promise<readonly string[]>;

  readonly createGrant: (hostName: string, secret: string) => Promise<void>;

  readonly removeGrant: (hostName: string, secret: string) => Promise<boolean>;

  readonly readHost: (hostName: string) => Promise<BrokerHost | null>;

  readonly createHost: (hostKey: string) => Promise<BrokerHost>;

  readonly destroyHost: (hostKey: string) => Promise<void>;
}

export interface BrokerIdentity {
  readonly name: string;
  readonly scope: 'read' | 'exec' | 'manage';

  readonly hosts: readonly string[] | null;

  readonly grantable: readonly string[];
}

export interface BrokerSecret {
  readonly name: string;
  readonly kind: BrokerSecretKind;
  readonly rules: readonly BrokerSecretRule[];

  readonly oauth?: BrokerOAuthState;
}

export type BrokerSecretKind = 'anthropic' | 'custom' | 'github' | 'npm' | 'oauth' | 'static';

export interface BrokerSecretRule {
  readonly host: string;
  readonly header: string;
  readonly scheme: 'basic' | 'bearer' | 'raw';
  readonly user?: string;
}

interface BrokerOAuthState {
  readonly status: 'pending' | 'ready' | 'needs_login';

  readonly idClaims: Readonly<Record<string, unknown>> | null;
}

export interface BrokerHost {
  readonly id: string;
  readonly name: string;
}
