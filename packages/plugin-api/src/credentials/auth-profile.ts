export type AuthProfile = CustomAuthProfile | GitHubAuthProfile;

interface CustomAuthProfile {
  readonly name: string;

  readonly secret: string;

  readonly kind: 'custom' | 'oauth';
  readonly host: string;
  readonly header: string;

  readonly scheme: 'bearer' | 'raw';
  readonly env: Readonly<Record<string, string>>;

  readonly telemetry?: { readonly logs: boolean };

  readonly dependencies: readonly string[];
}

interface GitHubAuthProfile {
  readonly name: string;
  readonly secret: string;
  readonly kind: 'github';
  readonly env: Readonly<Record<string, string>>;
  readonly dependencies: readonly string[];
}
