import { faker } from '@faker-js/faker';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import type { FleetEntry } from '../store/fleet-entry';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

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
