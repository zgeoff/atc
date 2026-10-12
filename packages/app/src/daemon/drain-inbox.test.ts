import { expect, mock, test } from 'bun:test';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import { buildStubHeldInboxSource } from '../test-utils/build-stub-held-inbox-source';
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
    v: 4,
    ev: 'InboxMessage',
    s: 's-shown',
    message: 'm-own',
    from: 'owner',
    text: 'hello',
    sentAt: 1,
  });
});
