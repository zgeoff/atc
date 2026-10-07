import { faker } from '@faker-js/faker';
import type { PartialDeep } from 'type-fest';
import type { AuthProfile } from '../shared/collect-auth-profiles';
import { mergeDeep } from './merge-deep';

/**
 * The auth profile kinds that inject a header for a broker host.
 */
type HeaderAuthProfile = Extract<AuthProfile, { readonly host: string }>;

/**
 * An auth profile of kind `custom` that sends its secret as a bearer token
 * in the `authorization` header, with no environment and no dependencies.
 * The name, secret, and host are arbitrary. Overrides merge into fresh
 * defaults at every depth.
 */
export function buildMockAuthProfile(
  overrides: PartialDeep<HeaderAuthProfile> = {},
): HeaderAuthProfile {
  return mergeDeep<HeaderAuthProfile>(
    {
      name: faker.string.alpha({ length: 8, casing: 'lower' }),
      secret: faker.string.alpha({ length: 8, casing: 'lower' }),
      kind: 'custom',
      host: faker.internet.domainName(),
      header: 'authorization',
      scheme: 'bearer',
      env: {},
      dependencies: [],
    },
    overrides,
  );
}
