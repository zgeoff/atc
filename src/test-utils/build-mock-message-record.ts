import { faker } from '@faker-js/faker';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import type { MessageRecord } from '../store/message-record';

type MessageRecordOverrides = {
  readonly [K in keyof MessageRecord]?: MessageRecord[K] | undefined;
};

/**
 * A message accepted for a session and not yet delivered: a fresh message
 * id and a fresh atc id, an arbitrary sender, text, and send time, and no
 * agent session id, delivery, answer, or turn. An override replaces the
 * field it names, and an override of undefined leaves that field out.
 */
export function buildMockMessageRecord(overrides: MessageRecordOverrides = {}): MessageRecord {
  return {
    id: toMessageID(faker.string.uuid()),
    atcID: toSessionID(faker.string.uuid()),
    from: faker.person.firstName(),
    text: faker.lorem.sentence(),
    status: 'accepted',
    sentAt: faker.date.past().getTime(),
    ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
  };
}
