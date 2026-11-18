import { toSessionID } from '@atcx/contract';
import { faker } from '@faker-js/faker';
import type { RuntimeAuthBinding } from '../runtime-auth-binding';

export function buildMockRuntimeAuthBinding(
  overrides: Partial<RuntimeAuthBinding> = {},
): RuntimeAuthBinding {
  const createdAt = faker.date.past().getTime();

  return {
    hostKey: toSessionID(faker.string.uuid()),
    target: 'box',
    targetIdentity: faker.string.alphanumeric(12),
    hostName: `atc-${faker.string.alphanumeric(20)}`,
    hostID: faker.string.uuid(),
    revision: 1,
    bindingHash: faker.string.hexadecimal({ length: 64, prefix: '' }),
    bindingJSON: '{}',
    state: 'ready',
    attemptID: faker.string.uuid(),
    hostCreatedByAttempt: true,
    rebind: null,
    createdAt,
    updatedAt: createdAt,
    revokedAt: null,
    ...overrides,
  };
}
