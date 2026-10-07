import { faker } from '@faker-js/faker';
import type { AgentEntry } from '../shared/collect-agents';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

/**
 * The fields the defaults set; every other field is absent until an
 * override gives it whole.
 */
type DefaultedKey = 'id' | 'kind' | 'label' | 'mark' | 'bin' | 'args' | 'env';

/**
 * A registry entry for a plain Claude agent: kind `claude`, no arguments,
 * no environment, and none of the gateway fields. The id, label, mark, and
 * binary are arbitrary. Overrides merge into fresh defaults at every depth.
 */
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
