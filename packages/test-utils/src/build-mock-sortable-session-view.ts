import type { SortableSessionView } from '@atc/protocol';
import { faker } from '@faker-js/faker';

export function buildMockSortableSessionView(
  overrides: Partial<SortableSessionView> = {},
): SortableSessionView {
  return {
    id: faker.string.uuid(),
    parent: null,
    state: 'running',
    pinned: false,
    lastAttachedAt: faker.date.recent().getTime(),
    createdAt: faker.date.past().getTime(),
    ...overrides,
  };
}
