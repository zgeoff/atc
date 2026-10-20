import type { MockOverrides } from '@atc/test-utils';
import { faker } from '@faker-js/faker';
import { mergeDeep } from '@zgeoff/std';
import type { StoredRow } from '../snapshot/read-stored-rows';

export function buildMockStoredRow(
  overrides: MockOverrides<StoredRow, keyof StoredRow> = {},
): StoredRow {
  return mergeDeep<StoredRow>(
    {
      id: faker.string.uuid(),
      name: faker.word.noun(),
      exited: false,
    },
    overrides,
  );
}
