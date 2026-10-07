import { faker } from '@faker-js/faker';
import type { GatewayConfig } from '../shared/collect-gateways';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

/**
 * The fields the defaults set; every other field is absent until an
 * override gives it whole.
 */
type DefaultedKey = 'id' | 'label' | 'mark' | 'bin' | 'args' | 'baseURL' | 'env';

/**
 * A Claude-compatible backend with no arguments, no environment, no helper
 * command, no settings, and no auth. The id, label, mark, binary, and base
 * URL are arbitrary. Overrides merge into fresh defaults at every depth.
 */
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
