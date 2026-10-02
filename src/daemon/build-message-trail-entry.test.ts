import { expect, test } from 'bun:test';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import { buildMessageTrailEntry } from './build-message-trail-entry';

test('it builds an accepted entry stamped with the sent time and a text preview', () => {
  const entry = buildMessageTrailEntry(toSessionID('s1'), toAgentSessionID('c1'), {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello',
    status: 'accepted',
    sentAt: 1000,
  });

  expect(entry).toStrictEqual({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('c1'),
    kind: 'message-accepted',
    message: toMessageID('m-1'),
    detail: 'hello',
  });
});

test('it builds a delivered entry stamped with the delivery time', () => {
  const entry = buildMessageTrailEntry(toSessionID('s1'), toAgentSessionID('c1'), {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello',
    status: 'delivered',
    sentAt: 1000,
    deliveredAt: 2000,
  });

  expect(entry).toStrictEqual({
    at: 2000,
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('c1'),
    kind: 'message-delivered',
    message: toMessageID('m-1'),
    detail: 'hello',
  });
});

test('it builds an answered entry stamped with the answer time and an answer preview', () => {
  const entry = buildMessageTrailEntry(toSessionID('s1'), toAgentSessionID('c1'), {
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

  expect(entry).toStrictEqual({
    at: 3000,
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('c1'),
    kind: 'message-answered',
    message: toMessageID('m-1'),
    detail: 'done',
  });
});

test('it falls back to the agent session id the message carries', () => {
  const entry = buildMessageTrailEntry(toSessionID('s1'), undefined, {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('c2'),
    from: 'alice',
    text: 'hello',
    status: 'accepted',
    sentAt: 1000,
  });

  expect(entry).toMatchObject({ agentSessionID: toAgentSessionID('c2') });
});

test('it holds no agent session id when neither the session nor the message has one', () => {
  const entry = buildMessageTrailEntry(toSessionID('s1'), undefined, {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello',
    status: 'accepted',
    sentAt: 1000,
  });

  expect(entry).toMatchObject({ agentSessionID: null });
});

test('it caps the detail at the preview length', () => {
  const entry = buildMessageTrailEntry(toSessionID('s1'), undefined, {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'x'.repeat(700),
    status: 'accepted',
    sentAt: 1000,
  });

  expect(entry).toMatchObject({ detail: `${'x'.repeat(599)}…` });
});
