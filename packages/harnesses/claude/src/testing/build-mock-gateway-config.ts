import { mergeDeep } from '@atc/test-utils';
import type { MockOverrides } from '@atc/test-utils';
import { faker } from '@faker-js/faker';
import type { GatewayConfig } from '../config/collect-gateways';

type DefaultedKey = 'id' | 'label' | 'mark' | 'bin' | 'args' | 'baseURL' | 'env';

// overrides merge into fresh defaults at every depth
export function buildMockGatewayConfig(
  overrides: MockOverrides<GatewayConfig, DefaultedKey> = {},
): GatewayConfig {
  return mergeDeep<GatewayConfig, DefaultedKey>(
    {
      id: faker.string.alpha({ length: 8, casing: 'lower' }),
      label: faker.company.name(),
      mark: faker.string.alpha({ length: 1, casing: 'lower' }),
      bin: faker.system.filePath(),
      args: [],
      baseURL: faker.internet.url(),
      env: {},
    },
    overrides,
  );
}
