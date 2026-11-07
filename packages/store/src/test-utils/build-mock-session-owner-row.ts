import type { MockOverrides } from '@atc/test-utils';
import { faker } from '@faker-js/faker';
import { mergeDeep } from '@zgeoff/std';
import type { Selectable } from 'kysely';
import type { StateStoreSchema } from '../sqlite/state-store-schema';

export type SessionOwnerRow = Selectable<StateStoreSchema['session_owner']>;

export function buildMockSessionOwnerRow(
  overrides: MockOverrides<SessionOwnerRow, keyof SessionOwnerRow> = {},
): SessionOwnerRow {
  return mergeDeep<SessionOwnerRow>(
    {
      session_id: faker.string.uuid(),
      daemon_id: faker.string.uuid(),
      owner_epoch: 1,
      updated_at: 0,
    },
    overrides,
  );
}
