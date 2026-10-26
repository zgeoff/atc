import type { BrokerSecretRule } from '@atc/plugin-api';

// The rules a broker gives a github secret: git over HTTPS on github.com
// takes Basic auth, and the REST and upload APIs take a bearer token.
export const GITHUB_SECRET_RULES: readonly BrokerSecretRule[] = [
  { host: 'api.github.com', header: 'authorization', scheme: 'bearer' },
  { host: 'github.com', header: 'authorization', scheme: 'basic', user: 'x-access-token' },
  { host: 'uploads.github.com', header: 'authorization', scheme: 'bearer' },
];
