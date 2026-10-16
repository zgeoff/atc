import { toSessionID } from '@atc/core';
import { faker } from '@faker-js/faker';
import type { RuntimeAuthBinding } from '../runtime-auth-binding';

/**
 * A ready runtime auth binding at revision 1 on the `imp` target, with no
 * rebind in flight and never revoked: an arbitrary host, imp name and id,
 * binding hash, and attempt, an empty binding, and a creation time it was
 * last updated at. Overrides replace the fields they hold.
 */
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
