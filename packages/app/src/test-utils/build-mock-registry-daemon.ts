import { faker } from '@faker-js/faker';
import type { RegistryDaemon } from '../federation/types';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

/**
 * A registry daemon with an arbitrary name, address, pinned daemon id,
 * and token. Its incarnation is the first 8 characters of the
 * daemon id in play, the override's when one is given, so a gateway id
 * built from it routes back unless an override sets the incarnation too.
 * Overrides merge into fresh defaults at every depth.
 */
export function buildMockRegistryDaemon(
  overrides: MockOverrides<RegistryDaemon, keyof RegistryDaemon> = {},
): RegistryDaemon {
  const daemonID = overrides.daemonID ?? faker.string.uuid();

  return mergeDeep<RegistryDaemon>(
    {
      name: faker.string.alpha({ length: 8, casing: 'lower' }),
      address: { host: faker.internet.ipv4(), port: faker.internet.port() },
      daemonID,
      incarnation: daemonID.slice(0, 8),
      token: faker.string.hexadecimal({ length: 32, casing: 'lower', prefix: '' }),
    },
    overrides,
  );
}
