import { toMessageID, toSessionID } from '@atcx/contract';
import { faker } from '@faker-js/faker';
import type { MessageRecord } from '../message-record';

type MessageRecordOverrides = {
  readonly [K in keyof MessageRecord]?: MessageRecord[K] | undefined;
};

export function buildMockMessageRecord(overrides: MessageRecordOverrides = {}): MessageRecord {
  return {
    id: toMessageID(faker.string.uuid()),
    atcID: toSessionID(faker.string.uuid()),
    from: faker.person.firstName(),
    text: faker.lorem.sentence(),
    status: 'queued',
    sentAt: faker.date.past().getTime(),
    ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
  };
}
