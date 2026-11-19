import type { DaemonAnswer } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import type { IdempotencyRecord, StateStore } from '@atc/store';
import { MESSAGE_ANSWER_SCHEMA, toMessageID } from '@atcx/contract';

export async function loadMessageReplay(
  store: Pick<StateStore, 'readMessageByID'>,
  record: IdempotencyRecord,
): Promise<DaemonAnswer<'session.message'>> {
  const current = await store.readMessageByID(toMessageID(record.effectRef));

  if (current !== null) {
    return { message: current.id, status: current.status };
  }

  const result: unknown = record.result === null ? null : JSON.parse(record.result);
  const stored = MESSAGE_ANSWER_SCHEMA.safeParse(result);

  if (stored.success) {
    return stored.data;
  }

  throw new DaemonError(
    'internal',
    `the message under idempotency key '${record.key}' has no stored row`,
    { effectRef: record.effectRef },
  );
}
