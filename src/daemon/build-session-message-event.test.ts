import { expect, test } from 'bun:test';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import { buildSessionMessageEvent } from './build-session-message-event';

test('it builds an accepted event without delivery or answer fields', () => {
  const event = buildSessionMessageEvent(toSessionID('s1'), {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello',
    status: 'accepted',
    sentAt: 1000,
  });

  expect(event).toStrictEqual({
    v: 3,
    ev: 'SessionMessage',
    s: 's1',
    message: 'm-1',
    status: 'accepted',
    from: 'alice',
    text: 'hello',
    sentAt: 1000,
  });
});

test('it builds an answered event with the answer and both timestamps', () => {
  const event = buildSessionMessageEvent(toSessionID('s2'), {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello',
    status: 'answered',
    sentAt: 1000,
    deliveredAt: 2000,
    answeredAt: 3000,
    answer: 'done',
  });

  expect(event).toStrictEqual({
    v: 3,
    ev: 'SessionMessage',
    s: 's2',
    message: 'm-1',
    status: 'answered',
    from: 'alice',
    text: 'hello',
    sentAt: 1000,
    deliveredAt: 2000,
    answeredAt: 3000,
    answer: 'done',
  });
});
