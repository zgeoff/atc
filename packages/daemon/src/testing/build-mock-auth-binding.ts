import { toAgentID } from '@atc/core';
import { mergeDeep } from '@atc/test-utils';
import type { MockOverrides } from '@atc/test-utils';
import { faker } from '@faker-js/faker';
import type { AuthBinding } from '../auth/build-auth-binding';

export function buildMockAuthBinding(
  overrides: MockOverrides<AuthBinding, keyof AuthBinding> = {},
): AuthBinding {
  return mergeDeep<AuthBinding>(
    {
      agent: toAgentID('glm'),
      baseURL: faker.internet.url(),
      profiles: [],
      secrets: [],
      placeholderEnv: {},
      profileEnv: {},
      hash: faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' }),
    },
    overrides,
  );
}
