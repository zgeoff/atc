import { toSessionID } from '@atc/core';
import { faker } from '@faker-js/faker';
import type { RuntimeAuthBinding } from '../runtime-auth-binding';

export function buildMockRuntimeAuthBinding(
  overrides: Partial<RuntimeAuthBinding> = {},
): RuntimeAuthBinding {
  const createdAt = faker.date.past().getTime();

  return {
    hostKey: toSessionID(faker.string.uuid()),
    target: 'imp',
    targetIdentity: faker.string.alphanumeric(12),
    impName: `atc-${faker.string.alphanumeric(20)}`,
    impID: faker.string.uuid(),
    revision: 1,
    bindingHash: faker.string.hexadecimal({ length: 64, prefix: '' }),
    bindingJSON: '{}',
    state: 'ready',
    attemptID: faker.string.uuid(),
    impCreatedByAttempt: true,
    rebind: null,
    createdAt,
    updatedAt: createdAt,
    revokedAt: null,
    ...overrides,
  };
}
