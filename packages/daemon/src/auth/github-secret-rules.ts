import type { BrokerSecretRule } from '@atc/plugin-api';

// Git over HTTPS on github.com rejects bearer tokens and needs Basic auth with a fixed user name.
export const GITHUB_SECRET_RULES: readonly BrokerSecretRule[] = [
  { host: 'api.github.com', header: 'authorization', scheme: 'bearer' },
  { host: 'github.com', header: 'authorization', scheme: 'basic', user: 'x-access-token' },
  { host: 'uploads.github.com', header: 'authorization', scheme: 'bearer' },
];
