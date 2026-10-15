import { expect, test } from 'bun:test';
import { toAgentSessionID, toMessageID, toSessionID } from '@atc/core';
import { buildMockMessageRecord } from '@atc/store/testing';
import { buildNoticeTrailEntry } from './build-notice-trail-entry';

test('it builds a queued notice entry for the sender, stamped with the queue time and an answer preview', () => {
  const entry = buildNoticeTrailEntry(
    toSessionID('sender'),
    toAgentSessionID('c1'),
    buildMockMessageRecord({
      id: toMessageID('m-1'),
      atcID: toSessionID('recipient'),
      status: 'answered',
      answer: 'the tests pass',
      sentAt: 1000,
      noticeQueuedAt: 3000,
    }),
    'notice-queued',
  );

  expect(entry).toStrictEqual({
    at: 3000,
    atcID: toSessionID('sender'),
    agentSessionID: toAgentSessionID('c1'),
    kind: 'notice-queued',
    message: toMessageID('m-1'),
    detail: 'the tests pass',
  });
});

test('it builds a delivered notice entry stamped with the delivery time and the unanswered reason', () => {
  const entry = buildNoticeTrailEntry(
    toSessionID('sender'),
    undefined,
    buildMockMessageRecord({
      id: toMessageID('m-1'),
      status: 'unanswered',
      unansweredReason: 'session_ended',
      sentAt: 1000,
      noticeQueuedAt: 3000,
      noticeDeliveredAt: 4000,
    }),
    'notice-delivered',
  );

  expect(entry).toStrictEqual({
    at: 4000,
    atcID: toSessionID('sender'),
    agentSessionID: null,
    kind: 'notice-delivered',
    message: toMessageID('m-1'),
    detail: 'session_ended',
  });
});
