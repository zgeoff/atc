import { toAgentSessionID, toSessionID } from '@atc/core';
import type { MockOverrides } from '@atc/test-utils';
import { faker } from '@faker-js/faker';
import { mergeDeep } from '@zgeoff/std';
import type { FleetEntry } from '../fleet-entry';

type DefaultedKey = 'sessionID' | 'name' | 'cwd' | 'agentSessionID' | 'agent';

export function buildMockFleetEntry(
  overrides: MockOverrides<FleetEntry, DefaultedKey> = {},
): FleetEntry {
  return mergeDeep<FleetEntry>(
    {
      sessionID: toSessionID(faker.string.uuid()),
      name: faker.word.noun(),
      cwd: faker.system.directoryPath(),
      agentSessionID: toAgentSessionID(faker.string.uuid()),
      agent: 'claude',
    },
    overrides,
  );
}
