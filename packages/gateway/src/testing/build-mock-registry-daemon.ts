import type { MockOverrides } from '@atc/test-utils';
import { faker } from '@faker-js/faker';
import { mergeDeep } from '@zgeoff/std';
import type { RegistryDaemon } from '../types';

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
