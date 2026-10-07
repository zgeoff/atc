import { faker } from '@faker-js/faker';
import type { AuthBinding } from '../daemon/build-auth-binding';
import { toAgentID } from '../shared/to-agent-id';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

/**
 * A runtime auth binding for agent `glm` at an arbitrary endpoint, reaching
 * no profile and needing no secret, with no placeholder or profile
 * variables and an arbitrary hash. Overrides merge into fresh defaults at
 * every depth, and a list replaces its default whole.
 */
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
