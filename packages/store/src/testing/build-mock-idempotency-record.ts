import { faker } from '@faker-js/faker';
import type { IdempotencyRecord } from '../idempotency-record';

/**
 * A completed idempotency key with no stored answer and no effect target:
 * an arbitrary principal, operation, key, payload hash, and effect id, and
 * a creation time it was last updated at. Overrides replace the fields
 * they hold.
 */
export function buildMockIdempotencyRecord(
  overrides: Partial<IdempotencyRecord> = {},
): IdempotencyRecord {
  const createdAt = faker.date.past().getTime();

  return {
    principal: faker.internet.username(),
    operation: faker.word.verb(),
    key: faker.string.uuid(),
    payloadHash: faker.string.hexadecimal({ length: 64, prefix: '' }),
    state: 'completed',
    effectRef: faker.string.uuid(),
    result: null,
    effectTarget: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}
