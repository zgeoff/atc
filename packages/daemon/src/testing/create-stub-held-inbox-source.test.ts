import { expect, test } from 'bun:test';
import { toAgentSessionID, toSessionID } from '@atc/core';
import { buildMockMessageRecord } from '@atc/store/testing';
import { createStubHeldInboxSource } from './create-stub-held-inbox-source';

test('it starts with no tap in its registry', () => {
  const inbox = createStubHeldInboxSource(toAgentSessionID('a-1'));

  expect(inbox.source.taps.findTap(toSessionID('s1'))).toBeNull();
});

test('it links every session to the agent session id it was given', () => {
  const inbox = createStubHeldInboxSource(toAgentSessionID('a-1'));

  expect(inbox.source.findLinkedOwner(toSessionID('s1'))).toStrictEqual({
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('a-1'),
  });
});

test('it holds a pending-message read until the test answers it', async () => {
  const inbox = createStubHeldInboxSource(toAgentSessionID('a-1'));
  const read = inbox.source.readPendingMessages({ atcID: toSessionID('s1') });

  await inbox.reading;

  expect(Bun.peek.status(read)).toBe('pending');
});

test('it answers a held read with the messages the test gives', async () => {
  const inbox = createStubHeldInboxSource(toAgentSessionID('a-1'));
  const read = inbox.source.readPendingMessages({ atcID: toSessionID('s1') });
  const record = buildMockMessageRecord({ atcID: toSessionID('s1') });

  inbox.answer([record]);

  const records = await read;

  expect(records).toStrictEqual([record]);
});
