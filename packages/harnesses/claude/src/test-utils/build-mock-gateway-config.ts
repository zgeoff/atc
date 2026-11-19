import type { MockOverrides } from '@atc/core/test-utils/mock-overrides';
import { faker } from '@faker-js/faker';
import { mergeDeep } from '@zgeoff/std';
import type { GatewayConfig } from '../config/collect-gateways';

type DefaultedKey = 'id' | 'label' | 'mark' | 'bin' | 'args' | 'baseURL' | 'env';

export function buildMockGatewayConfig(
  overrides: MockOverrides<GatewayConfig, DefaultedKey> = {},
): GatewayConfig {
  return mergeDeep<GatewayConfig>(
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
