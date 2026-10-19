import type { SessionID } from '@atc/core';
import type { PublishedRecord } from '@atc/protocol';
import type { Kysely } from 'kysely';
import { parsePublishedRecord } from './parse-published-record';
import type { StateStoreSchema } from './sqlite/state-store-schema';

// The record each session last published, keyed by the session.
export class PublishedRecordStore {
  private readonly db: Kysely<StateStoreSchema>;

  constructor(db: Kysely<StateStoreSchema>) {
    this.db = db;
  }

  // A row whose JSON no longer reads as a record counts as no record, so
  // the next delivery records the session afresh.
  async readPublishedRecord(sessionID: SessionID): Promise<PublishedRecord | null> {
    const row = await this.db
      .selectFrom('published_record')
      .select('record')
      .where('session_id', '=', sessionID)
      .executeTakeFirst();

    return row === undefined ? null : parsePublishedRecord(row.record);
  }

  async writePublishedRecord(record: PublishedRecord): Promise<void> {
    const values = {
      record: JSON.stringify(record),
      revision: record.revision,
      updated_at: Date.parse(record.updatedAt),
    };

    await this.db
      .insertInto('published_record')
      .values({ session_id: record.session, ...values })
      .onConflict((oc) => oc.column('session_id').doUpdateSet(values))
      .execute();
  }

  async removePublishedRecord(sessionID: SessionID): Promise<void> {
    await this.db.deleteFrom('published_record').where('session_id', '=', sessionID).execute();
  }
}
