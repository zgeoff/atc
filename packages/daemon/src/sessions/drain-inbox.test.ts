import { expect, mock, test } from 'bun:test';
import { toAgentSessionID, toMessageID, toSessionID } from '@atc/core';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import { buildStubHeldInboxSource } from '../testing/build-stub-held-inbox-source';
import { drainInbox } from './drain-inbox';

test("it sends a principal's tap that replaced the owner's during the read no message the owner's read found", async () => {
  const inbox = buildStubHeldInboxSource(toAgentSessionID('a-shared'));
  const owner = { sendEvent: mock() };
  const principal = { sendEvent: mock() };

  inbox.source.taps.attach(toSessionID('s-shown'), owner, true);

  const drain = drainInbox(toSessionID('s-shown'), inbox.source);

  await inbox.reading;

  inbox.source.taps.attach(toSessionID('s-shown'), principal, false);

  inbox.answer([
    {
      id: toMessageID('m-hidden'),
      atcID: toSessionID('s-hidden'),
      agentSessionID: toAgentSessionID('a-shared'),
      from: 'owner',
      text: 'secret',
      status: 'queued',
      sentAt: 0,
    },
  ]);

  await drain;

  expect(principal.sendEvent).not.toHaveBeenCalled();
  expect(owner.sendEvent).not.toHaveBeenCalled();
});

test('it sends a tap that replaced the one a drain read for nothing from that drain', async () => {
  const inbox = buildStubHeldInboxSource(toAgentSessionID('a-shared'));
  const first = { sendEvent: mock() };
  const second = { sendEvent: mock() };

  inbox.source.taps.attach(toSessionID('s-shown'), first, true);

  const drain = drainInbox(toSessionID('s-shown'), inbox.source);

  await inbox.reading;

  inbox.source.taps.attach(toSessionID('s-shown'), second, true);

  inbox.answer([
    {
      id: toMessageID('m-1'),
      atcID: toSessionID('s-shown'),
      from: 'owner',
      text: 'hello',
      status: 'queued',
      sentAt: 0,
    },
  ]);

  await drain;

  expect(second.sendEvent).not.toHaveBeenCalled();
  expect(first.sendEvent).not.toHaveBeenCalled();
});

test("it sends an unlinked tap no message sent to another session's atc id", async () => {
  const inbox = buildStubHeldInboxSource(toAgentSessionID('a-shared'));
  const tap = { sendEvent: mock() };

  inbox.source.taps.attach(toSessionID('s-shown'), tap, false);

  const drain = drainInbox(toSessionID('s-shown'), inbox.source);

  inbox.answer([
    {
      id: toMessageID('m-hidden'),
      atcID: toSessionID('s-hidden'),
      agentSessionID: toAgentSessionID('a-shared'),
      from: 'owner',
      text: 'secret',
      status: 'queued',
      sentAt: 0,
    },
    {
      id: toMessageID('m-own'),
      atcID: toSessionID('s-shown'),
      from: 'owner',
      text: 'hello',
      status: 'queued',
      sentAt: 1,
    },
  ]);

  await drain;

  expect(tap.sendEvent).toHaveBeenCalledExactlyOnceWith({
    version: 10,
    ev: 'InboxMessage',
    sessionID: 's-shown',
    message: 'm-own',
    from: 'owner',
    text: 'hello',
    sentAt: 1,
  });
});

test('it sends a tap without notices no answer notice', async () => {
  const inbox = buildStubHeldInboxSource(toAgentSessionID('a-1'), [
    {
      id: toMessageID('m-sent'),
      atcID: toSessionID('s-other'),
      from: 's-1',
      text: 'check the build',
      status: 'answered',
      answer: 'the build is green',
      sentAt: 0,
      senderSession: toSessionID('s-1'),
      noticeQueuedAt: 5,
    },
  ]);

  const tap = { sendEvent: mock() };

  inbox.source.taps.attach(toSessionID('s-1'), tap, true);

  const drain = drainInbox(toSessionID('s-1'), inbox.source);

  inbox.answer([]);

  await drain;

  expect(tap.sendEvent).not.toHaveBeenCalled();
});

test('it sends a tap with notices the answer notice of a message its session sent', async () => {
  const inbox = buildStubHeldInboxSource(toAgentSessionID('a-1'), [
    {
      id: toMessageID('m-sent'),
      atcID: toSessionID('s-other'),
      from: 's-1',
      text: 'check the build',
      status: 'unanswered',
      unansweredReason: 'interrupted',
      sentAt: 0,
      senderSession: toSessionID('s-1'),
      noticeQueuedAt: 5,
    },
  ]);

  const tap = { sendEvent: mock() };

  inbox.source.taps.attach(toSessionID('s-1'), tap, true, true);

  const drain = drainInbox(toSessionID('s-1'), inbox.source);

  inbox.answer([]);

  await drain;

  expect(tap.sendEvent.mock.calls).toStrictEqual([
    [
      {
        version: PROTOCOL_V,
        ev: 'InboxNotice',
        sessionID: 's-1',
        message: 'm-sent',
        from: 's-other',
        status: 'unanswered',
        reason: 'interrupted',
        at: 5,
      },
    ],
  ]);
});

test('it sends a pending message ahead of an answer notice', async () => {
  const inbox = buildStubHeldInboxSource(toAgentSessionID('a-1'), [
    {
      id: toMessageID('m-self'),
      atcID: toSessionID('s-1'),
      from: 's-1',
      text: 'note to self',
      status: 'answered',
      answer: 'noted',
      sentAt: 0,
      senderSession: toSessionID('s-1'),
      noticeQueuedAt: 5,
    },
  ]);

  const tap = { sendEvent: mock<(event: EventMsg) => void>() };

  inbox.source.taps.attach(toSessionID('s-1'), tap, true, true);

  const drain = drainInbox(toSessionID('s-1'), inbox.source);

  inbox.answer([
    {
      id: toMessageID('m-self'),
      atcID: toSessionID('s-1'),
      from: 's-1',
      text: 'note to self',
      status: 'queued',
      sentAt: 0,
    },
  ]);

  await drain;
  await drainInbox(toSessionID('s-1'), inbox.source);

  expect(tap.sendEvent.mock.calls.map(([event]) => event.ev)).toStrictEqual([
    'InboxMessage',
    'InboxNotice',
  ]);
});
