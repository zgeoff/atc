import { mergeDeep } from '@atc/test-utils';
import type { MockOverrides } from '@atc/test-utils';
import { faker } from '@faker-js/faker';
import type { StoredRow } from '../snapshot/read-stored-rows';

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
