import type { MockOverrides } from '@atc/test-utils';
import { faker } from '@faker-js/faker';
import { mergeDeep } from '@zgeoff/std';
import type { GatewayStore } from '../gateway-store';

type KeyBindingClaim = Parameters<GatewayStore['claimBinding']>[0];

export function buildMockKeyBindingClaim(
  overrides: MockOverrides<KeyBindingClaim, keyof KeyBindingClaim> = {},
): KeyBindingClaim {
  return mergeDeep<KeyBindingClaim>(
    {
      principal: faker.string.alphanumeric(12),
      operation: 'session.spawn',
      key: faker.string.alphanumeric(16),
      daemon: faker.string.alpha({ length: 8, casing: 'lower' }),
      daemonID: faker.string.uuid(),
      retentionMs: faker.number.int({ min: 1000, max: 86_400_000 }),
      payloadHash: faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' }),
      claimID: faker.string.uuid(),
    },
    overrides,
  );
}
