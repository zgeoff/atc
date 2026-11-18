import type { MockOverrides } from '@atc/core/test-utils/mock-overrides';
import { faker } from '@faker-js/faker';
import { mergeDeep } from '@zgeoff/std';
import type { AgentEntry } from '../index';

type DefaultedKey = 'id' | 'kind' | 'label' | 'mark' | 'bin' | 'args' | 'env';

export function buildMockAgentEntry(
  overrides: MockOverrides<AgentEntry, DefaultedKey> = {},
): AgentEntry {
  return mergeDeep<AgentEntry>(
    {
      id: faker.string.alpha({ length: 8, casing: 'lower' }),
      kind: 'claude',
      label: faker.company.name(),
      mark: faker.string.alpha({ length: 1, casing: 'lower' }),
      bin: faker.system.filePath(),
      args: [],
      env: {},
    },
    overrides,
  );
}
