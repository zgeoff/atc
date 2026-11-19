import { faker } from '@faker-js/faker';
import type { SortableSessionView } from '../index';

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
