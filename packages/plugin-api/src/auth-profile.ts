export type AuthProfile = CustomAuthProfile | GitHubAuthProfile;

// the rule the broker applies when a request reaches the profile's host.
interface CustomAuthProfile {
  readonly name: string;

  // the secret's name, never its value.
  readonly secret: string;

  // `oauth` is a secret whose access token the broker renews from a refresh
  // token.
  readonly kind: 'custom' | 'oauth';
  readonly host: string;
  readonly header: string;

  // `raw` holds the value alone, as an `x-api-key` header does.
  readonly scheme: 'bearer' | 'raw';
  readonly env: Readonly<Record<string, string>>;

  // the profiles a session selecting this one needs beside it.
  readonly dependencies: readonly string[];
}

// holds no rule: the broker's `github` secret fixes its hosts and headers.
interface GitHubAuthProfile {
  readonly name: string;
  readonly secret: string;
  readonly kind: 'github';
  readonly env: Readonly<Record<string, string>>;
  readonly dependencies: readonly string[];
}
