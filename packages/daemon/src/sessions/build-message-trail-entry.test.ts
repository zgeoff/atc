import { expect, test } from 'bun:test';
import { toAgentSessionID, toMessageID, toSessionID } from '@atc/core';
import { buildMockMessageRecord } from '@atc/store/testing';
import { buildMessageTrailEntry } from './build-message-trail-entry';

test('it builds a queued entry stamped with the sent time and a text preview', () => {
  const entry = buildMessageTrailEntry(
    toSessionID('s1'),
    toAgentSessionID('c1'),
    buildMockMessageRecord({
      id: toMessageID('m-1'),
      text: 'hello',
      status: 'queued',
      sentAt: 1000,
    }),
  );

  expect(entry).toStrictEqual({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('c1'),
    kind: 'message-queued',
    message: toMessageID('m-1'),
    detail: 'hello',
  });
});

test('it builds a delivered entry stamped with the delivery time', () => {
  const entry = buildMessageTrailEntry(
    toSessionID('s1'),
    toAgentSessionID('c1'),
    buildMockMessageRecord({
      id: toMessageID('m-1'),
      text: 'hello',
      status: 'delivered',
      sentAt: 1000,
      deliveredAt: 2000,
    }),
  );

  expect(entry).toStrictEqual({
    at: 2000,
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('c1'),
    kind: 'message-delivered',
    message: toMessageID('m-1'),
    detail: 'hello',
  });
});

test('it builds an answered entry stamped with the answer time, an answer preview and the whole answer', () => {
  const entry = buildMessageTrailEntry(
    toSessionID('s1'),
    toAgentSessionID('c1'),
    buildMockMessageRecord({
      id: toMessageID('m-1'),
      text: 'hello',
      status: 'answered',
      sentAt: 1000,
      deliveredAt: 2000,
      answeredAt: 3000,
      answer: 'r'.repeat(700),
    }),
  );

  expect(entry).toStrictEqual({
    at: 3000,
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('c1'),
    kind: 'message-answered',
    message: toMessageID('m-1'),
    detail: `${'r'.repeat(599)}…`,
    text: 'r'.repeat(700),
  });
});

test('it falls back to the agent session id the message carries', () => {
  const entry = buildMessageTrailEntry(
    toSessionID('s1'),
    undefined,
    buildMockMessageRecord({
      id: toMessageID('m-1'),
      agentSessionID: toAgentSessionID('c2'),
      text: 'hello',
      status: 'queued',
      sentAt: 1000,
    }),
  );

  expect(entry).toStrictEqual({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('c2'),
    kind: 'message-queued',
    message: toMessageID('m-1'),
    detail: 'hello',
  });
});

test('it holds no agent session id when neither the session nor the message has one', () => {
  const entry = buildMessageTrailEntry(
    toSessionID('s1'),
    undefined,
    buildMockMessageRecord({
      id: toMessageID('m-1'),
      agentSessionID: undefined,
      text: 'hello',
      status: 'queued',
      sentAt: 1000,
    }),
  );

  expect(entry).toStrictEqual({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'message-queued',
    message: toMessageID('m-1'),
    detail: 'hello',
  });
});

test('it caps the detail at the preview length', () => {
  const entry = buildMessageTrailEntry(
    toSessionID('s1'),
    undefined,
    buildMockMessageRecord({
      id: toMessageID('m-1'),
      text: 'x'.repeat(700),
      status: 'queued',
      sentAt: 1000,
    }),
  );

  expect(entry).toStrictEqual({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'message-queued',
    message: toMessageID('m-1'),
    detail: `${'x'.repeat(599)}…`,
  });
});

test('it builds an unanswered entry stamped with the unanswered time and a text preview', () => {
  const entry = buildMessageTrailEntry(
    toSessionID('s1'),
    toAgentSessionID('c1'),
    buildMockMessageRecord({
      id: toMessageID('m-1'),
      text: 'hello',
      status: 'unanswered',
      sentAt: 1000,
      deliveredAt: 2000,
      unansweredAt: 3000,
      unansweredReason: 'interrupted',
    }),
  );

  expect(entry).toStrictEqual({
    at: 3000,
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('c1'),
    kind: 'message-unanswered',
    message: toMessageID('m-1'),
    detail: 'hello',
  });
});
