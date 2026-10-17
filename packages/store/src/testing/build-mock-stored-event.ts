import { toSessionID } from '@atc/core';
import { faker } from '@faker-js/faker';
import type { StoredEvent } from '../state-store';

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
