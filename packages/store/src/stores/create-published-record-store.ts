import type { PublishedRecord, SessionID } from '@atcx/contract';
import type { Kysely } from 'kysely';
import { parsePublishedRecord } from '../published-records/parse-published-record';
import type { StateStoreSchema } from '../sqlite/state-store-schema';

export interface PublishedRecordStore {
  readonly readPublishedRecord: (sessionID: SessionID) => Promise<PublishedRecord | null>;
  readonly writePublishedRecord: (record: PublishedRecord) => Promise<void>;
  readonly removePublishedRecord: (sessionID: SessionID) => Promise<void>;
}

export function createPublishedRecordStore(db: Kysely<StateStoreSchema>): PublishedRecordStore {
  return {
    readPublishedRecord: async (sessionID) => {
      const row = await db
        .selectFrom('published_record')
        .select('record')
        .where('session_id', '=', sessionID)
        .executeTakeFirst();

      return row === undefined ? null : parsePublishedRecord(row.record);
    },

    writePublishedRecord: async (record) => {
      const values = {
        record: JSON.stringify(record),
        revision: record.revision,
        updated_at: Date.parse(record.updatedAt),
      };

      await db
        .insertInto('published_record')
        .values({ session_id: record.session, ...values })
        .onConflict((oc) => oc.column('session_id').doUpdateSet(values))
        .execute();
    },

    removePublishedRecord: async (sessionID) => {
      await db.deleteFrom('published_record').where('session_id', '=', sessionID).execute();
    },
  };
}
