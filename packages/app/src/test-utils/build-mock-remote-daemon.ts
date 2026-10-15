import type { RemoteDaemon } from '@atc/config/collect-remote-daemons';
import { faker } from '@faker-js/faker';

/**
 * A remote daemon from the config with an arbitrary name, address, token
 * file path, and principal. A token override replaces the default token source
 * whole, since a file source and a command source share no field to merge.
 */
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
