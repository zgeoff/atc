import type { AuthProfile } from '@atc/plugin-api';
import { faker } from '@faker-js/faker';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

type HeaderAuthProfile = Extract<AuthProfile, { readonly host: string }>;

type GitHubAuthProfile = Extract<AuthProfile, { readonly kind: 'github' }>;

type HeaderOverrides = MockOverrides<HeaderAuthProfile, keyof HeaderAuthProfile>;

type GitHubOverrides = MockOverrides<GitHubAuthProfile, keyof GitHubAuthProfile> & {
  readonly kind: 'github';
};

export function buildMockAuthProfile(overrides?: HeaderOverrides): HeaderAuthProfile;
export function buildMockAuthProfile(overrides: GitHubOverrides): GitHubAuthProfile;

export function buildMockAuthProfile(
  overrides: HeaderOverrides | GitHubOverrides = {},
): AuthProfile {
  const name = faker.string.alpha({ length: 8, casing: 'lower' });
  const secret = faker.string.alpha({ length: 8, casing: 'lower' });

  return isGitHubOverrides(overrides)
    ? mergeDeep<GitHubAuthProfile>(
        { name, secret, kind: 'github', env: {}, dependencies: [] },
        overrides,
      )
    : mergeDeep<HeaderAuthProfile>(
        {
          name,
          secret,
          kind: 'custom',
          host: faker.internet.domainName(),
          header: `x-${faker.string.alpha({ length: 6, casing: 'lower' })}-key`,
          scheme: 'bearer',
          env: {},
          dependencies: [],
        },
        overrides,
      );
}

function isGitHubOverrides(
  overrides: HeaderOverrides | GitHubOverrides,
): overrides is GitHubOverrides {
  return overrides.kind === 'github';
}
