import type { RemoteDaemon } from '@atc/config';
import { faker } from '@faker-js/faker';

export function buildMockRemoteDaemon(overrides: Partial<RemoteDaemon> = {}): RemoteDaemon {
  return {
    name: overrides.name ?? faker.string.alpha({ length: 8, casing: 'lower' }),
    host: overrides.host ?? faker.internet.ipv4(),
    port: overrides.port ?? faker.internet.port(),
    token: overrides.token ?? {
      kind: 'file',
      path: `/${faker.string.alpha({ length: 8, casing: 'lower' })}/daemon.token`,
    },
    principal: overrides.principal ?? faker.string.alpha({ length: 8, casing: 'lower' }),
  };
}
