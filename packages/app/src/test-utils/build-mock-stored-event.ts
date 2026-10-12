import { faker } from '@faker-js/faker';
import { toSessionID } from '../shared/to-session-id';
import type { StoredEvent } from '../store/state-store';

/**
 * A row of the event trail as the store reads it back: a `turn-done` event
 * with an arbitrary row id, time, and fresh atc id, and no agent session
 * id, detail, message, or label. Each override replaces the default of its field.
 */
export function buildMockStoredEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: faker.number.int({ min: 1, max: 1_000_000 }),
    at: faker.date.past().getTime(),
    atcID: toSessionID(faker.string.uuid()),
    agentSessionID: null,
    kind: 'turn-done',
    detail: null,
    ...overrides,
  };
}
