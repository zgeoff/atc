import type { AgentEntry } from '@atc/config';
import { faker } from '@faker-js/faker';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

type DefaultedKey = 'id' | 'kind' | 'label' | 'mark' | 'bin' | 'args' | 'env';

export function buildMockAgentEntry(
  overrides: MockOverrides<AgentEntry, DefaultedKey> = {},
): AgentEntry {
  return mergeDeep<AgentEntry, DefaultedKey>(
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
