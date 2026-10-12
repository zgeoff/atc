/**
 * A named reference to a credential impd holds: the secret's name, never
 * its value, and the profiles a session selecting this one needs beside
 * it. A `custom` profile holds the one rule impd applies when a request
 * reaches its host: a bearer header, or a raw one that holds the value
 * alone, as an `x-api-key` header does. An `oauth` profile holds the
 * same rule for a secret whose access token impd renews from a refresh
 * token. A `github` profile holds no rule: impd's `github` kind fixes its
 * hosts and headers.
 */
export type AuthProfile = CustomAuthProfile | GitHubAuthProfile;

interface CustomAuthProfile {
  readonly name: string;
  readonly secret: string;
  readonly kind: 'custom' | 'oauth';
  readonly host: string;
  readonly header: string;
  readonly scheme: 'bearer' | 'raw';
  readonly env: Readonly<Record<string, string>>;
  readonly dependencies: readonly string[];
}

interface GitHubAuthProfile {
  readonly name: string;
  readonly secret: string;
  readonly kind: 'github';
  readonly env: Readonly<Record<string, string>>;
  readonly dependencies: readonly string[];
}
