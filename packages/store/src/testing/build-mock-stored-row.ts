import { mergeDeep } from '@atc/test-utils/merge-deep';
import type { MockOverrides } from '@atc/test-utils/mock-overrides';
import { faker } from '@faker-js/faker';
import type { StoredRow } from '../snapshot/read-stored-rows';

/**
 * A fleet row a daemon has stored, for a live session with a fresh id, an
 * arbitrary name, and no known agent session id. Overrides replace the
 * defaults field by field.
 */
export function buildMockStoredRow(
  overrides: MockOverrides<StoredRow, keyof StoredRow> = {},
): StoredRow {
  return mergeDeep<StoredRow>(
    {
      id: faker.string.uuid(),
      name: faker.word.noun(),
      exited: false,
      agentSessionID: null,
    },
    overrides,
  );
}
