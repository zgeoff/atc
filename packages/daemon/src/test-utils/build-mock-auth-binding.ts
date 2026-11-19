import { toAgentID } from '@atc/core';
import type { MockOverrides } from '@atc/core/test-utils/mock-overrides';
import { faker } from '@faker-js/faker';
import { mergeDeep } from '@zgeoff/std';
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
      telemetryHost: null,
      hash: faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' }),
    },
    overrides,
  );
}
