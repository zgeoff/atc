import { faker } from '@faker-js/faker';
import type { PartialDeep } from 'type-fest';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import type { FleetEntry } from '../store/fleet-entry';
import { mergeDeep } from './merge-deep';

/**
 * A fleet row for a live Claude session on the local target: a fresh
 * session id and a fresh agent session id, so it restores as resumable,
 * with an arbitrary name and directory and every optional field absent.
 * Overrides merge into fresh defaults at every depth.
 */
export function buildMockFleetEntry(overrides: PartialDeep<FleetEntry> = {}): FleetEntry {
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
