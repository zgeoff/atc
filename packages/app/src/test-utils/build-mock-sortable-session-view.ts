import { faker } from '@faker-js/faker';
import type { SortableSessionView } from '../protocol/sortable-session-view';

/**
 * The ordering fields of a running, unpinned, top-level session, as the
 * session list sorts it. The id and both times are arbitrary.
 */
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
