import { expect, test } from 'bun:test';
import { toMessageID } from '@atc/core/to-message-id';
import { toSessionID } from '@atc/core/to-session-id';
import { buildMockMessageRecord } from '@atc/store/testing/build-mock-message-record';
import { buildSessionMessageEvent } from './build-session-message-event';

test('it builds a queued event without delivery or answer fields', () => {
  const event = buildSessionMessageEvent(
    toSessionID('s1'),
    buildMockMessageRecord({
      id: toMessageID('m-1'),
      from: 'alice',
      text: 'hello',
      status: 'queued',
      sentAt: 1000,
    }),
  );

  expect(event).toStrictEqual({
    v: 4,
    ev: 'SessionMessage',
    s: 's1',
    message: 'm-1',
    status: 'queued',
    from: 'alice',
    textPreview: 'hello',
    sentAt: 1000,
  });
});

test('it builds an answered event with the answer and both timestamps', () => {
  const event = buildSessionMessageEvent(
    toSessionID('s2'),
    buildMockMessageRecord({
      id: toMessageID('m-1'),
      atcID: toSessionID('s1'),
      from: 'alice',
      text: 'hello',
      status: 'answered',
      sentAt: 1000,
      deliveredAt: 2000,
      answeredAt: 3000,
      answer: 'done',
    }),
  );

  expect(event).toStrictEqual({
    v: 4,
    ev: 'SessionMessage',
    s: 's2',
    message: 'm-1',
    status: 'answered',
    from: 'alice',
    textPreview: 'hello',
    sentAt: 1000,
    deliveredAt: 2000,
    answeredAt: 3000,
    answerPreview: 'done',
  });
});

test('it carries only a preview of a long text and a long answer', () => {
  const event = buildSessionMessageEvent(
    toSessionID('s1'),
    buildMockMessageRecord({
      id: toMessageID('m-1'),
      from: 'alice',
      text: 'q'.repeat(5000),
      status: 'answered',
      sentAt: 1000,
      answeredAt: 3000,
      answer: 'a'.repeat(5000),
    }),
  );

  expect(event).toStrictEqual({
    v: 4,
    ev: 'SessionMessage',
    s: 's1',
    message: 'm-1',
    status: 'answered',
    from: 'alice',
    textPreview: `${'q'.repeat(599)}…`,
    sentAt: 1000,
    answeredAt: 3000,
    answerPreview: `${'a'.repeat(599)}…`,
  });
});

test('it builds an unanswered event with the reason and the unanswered time', () => {
  const event = buildSessionMessageEvent(
    toSessionID('s1'),
    buildMockMessageRecord({
      id: toMessageID('m-1'),
      atcID: toSessionID('s1'),
      from: 'alice',
      text: 'hello',
      status: 'unanswered',
      sentAt: 1000,
      unansweredAt: 3000,
      unansweredReason: 'refusal',
    }),
  );

  expect(event).toStrictEqual({
    v: 4,
    ev: 'SessionMessage',
    s: 's1',
    message: 'm-1',
    status: 'unanswered',
    from: 'alice',
    textPreview: 'hello',
    sentAt: 1000,
    unansweredAt: 3000,
    unansweredReason: 'refusal',
  });
});

test('it carries the sender of a message that holds one', () => {
  const event = buildSessionMessageEvent(
    toSessionID('s1'),
    buildMockMessageRecord({
      id: toMessageID('m-1'),
      from: 'Lantern Notes',
      sender: { kind: 'connector', client: 'client-7', name: 'Lantern Notes' },
      text: 'hello',
      status: 'queued',
      sentAt: 1000,
    }),
  );

  expect(event).toStrictEqual({
    v: 4,
    ev: 'SessionMessage',
    s: 's1',
    message: 'm-1',
    status: 'queued',
    from: 'Lantern Notes',
    sender: { kind: 'connector', client: 'client-7', name: 'Lantern Notes' },
    textPreview: 'hello',
    sentAt: 1000,
  });
});
