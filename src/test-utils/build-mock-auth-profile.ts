import { faker } from '@faker-js/faker';
import type { AuthProfile } from '../shared/collect-auth-profiles';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

/**
 * The auth profile kinds that inject a header for a broker host.
 */
type HeaderAuthProfile = Extract<AuthProfile, { readonly host: string }>;

/**
 * The auth profile kind that signs in to GitHub.
 */
type GitHubAuthProfile = Extract<AuthProfile, { readonly kind: 'github' }>;

type HeaderOverrides = MockOverrides<HeaderAuthProfile, keyof HeaderAuthProfile>;

type GitHubOverrides = MockOverrides<GitHubAuthProfile, keyof GitHubAuthProfile> & {
  readonly kind: 'github';
};

/**
 * An auth profile of kind `custom` that sends its secret as a bearer token
 * in a header, or, for an override of kind `github`, a GitHub profile.
 * Either has no environment and no dependencies, and an arbitrary name and
 * secret; a custom profile's host and header name are arbitrary too.
 * Overrides merge into fresh defaults at every depth.
 */
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
