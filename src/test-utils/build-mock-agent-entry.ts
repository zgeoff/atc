import { faker } from '@faker-js/faker';
import type { PartialDeep } from 'type-fest';
import type { AgentEntry } from '../shared/collect-agents';
import { mergeDeep } from './merge-deep';

/**
 * A registry entry for a plain Claude agent: kind `claude`, no arguments,
 * no environment, and none of the gateway fields. The id, label, mark, and
 * binary are arbitrary. Overrides merge into fresh defaults at every depth.
 */
export function buildMockAgentEntry(overrides: PartialDeep<AgentEntry> = {}): AgentEntry {
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
