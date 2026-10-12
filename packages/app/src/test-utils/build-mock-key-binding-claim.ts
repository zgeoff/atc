import { faker } from '@faker-js/faker';
import type { GatewayStore } from '../federation/gateway-store';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

/**
 * The binding a keyed request claims in the gateway store, before any
 * outcome or send is recorded for it.
 */
type KeyBindingClaim = Parameters<GatewayStore['claimBinding']>[0];

/**
 * A claim of a keyed spawn by an arbitrary principal under an arbitrary
 * key, bound to an arbitrary daemon that announced an arbitrary retention,
 * with an arbitrary payload hash and claim id. Overrides replace the
 * defaults field by field.
 */
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
