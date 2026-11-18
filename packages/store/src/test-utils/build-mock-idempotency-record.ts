import { faker } from '@faker-js/faker';
import type { IdempotencyRecord } from '../idempotency-record';

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
