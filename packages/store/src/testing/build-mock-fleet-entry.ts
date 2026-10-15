import { toAgentSessionID, toSessionID } from '@atc/core';
import { mergeDeep } from '@atc/test-utils';
import type { MockOverrides } from '@atc/test-utils';
import { faker } from '@faker-js/faker';
import type { FleetEntry } from '../fleet-entry';

/**
 * The fields the defaults set; every other field is absent until an
 * override gives it whole.
 */
type DefaultedKey = 'sessionID' | 'name' | 'cwd' | 'agentSessionID' | 'agent';

/**
 * A fleet row for a live Claude session on the local target: a fresh
 * session id and a fresh agent session id, so it restores as resumable,
 * with an arbitrary name and directory and every optional field absent.
 * Overrides merge into fresh defaults at every depth.
 */
export function buildMockFleetEntry(
  overrides: MockOverrides<FleetEntry, DefaultedKey> = {},
): FleetEntry {
  return mergeDeep<FleetEntry, DefaultedKey>(
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
