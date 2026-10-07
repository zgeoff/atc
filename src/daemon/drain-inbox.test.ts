import { expect, mock, test } from 'bun:test';
import type { SessionID } from '../shared/session-id';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import type { MessageRecord } from '../store/message-record';
import type { TapClient } from './daemon-context';
import { drainInbox } from './drain-inbox';
import { TapRegistry } from './tap-registry';

/**
 * An empty tap registry and an inbox source over it whose pending-message
 * read waits until the test answers it: `reading` settles once the read
 * starts, and `read` answers it with the given messages.
 */
function setupTest() {
  const taps = new TapRegistry<TapClient>();

  const pending = Promise.withResolvers<MessageRecord[]>();
  const reading = Promise.withResolvers<void>();

  return {
    taps,
    source: {
      taps,

      // A drain reads only for a session the daemon holds; this one holds
      // every session under one agent session id.
      findLinkedOwner: (sessionID: SessionID) => ({
        atcID: sessionID,
        agentSessionID: toAgentSessionID('a-shared'),
      }),
      collectPendingMessages: () => {
        reading.resolve();

        return pending.promise;
      },
    },
    reading: reading.promise,
    read: (records: readonly MessageRecord[]) => {
      pending.resolve([...records]);
    },
  };
}

test("it sends a principal's tap that replaced the owner's during the read no message the owner's read found", async () => {
  const ctx = setupTest();
  const owner = { sendEvent: mock() };
  const principal = { sendEvent: mock() };

  ctx.taps.attach(toSessionID('s-shown'), owner, true);

  const drain = drainInbox(toSessionID('s-shown'), ctx.source);

  await ctx.reading;

  ctx.taps.attach(toSessionID('s-shown'), principal, false);

  ctx.read([
    {
      id: toMessageID('m-hidden'),
      atcID: toSessionID('s-hidden'),
      agentSessionID: toAgentSessionID('a-shared'),
      from: 'owner',
      text: 'secret',
      status: 'accepted',
      sentAt: 0,
    },
  ]);

  await drain;

  expect(principal.sendEvent).not.toHaveBeenCalled();
  expect(owner.sendEvent).not.toHaveBeenCalled();
});

test('it sends a tap that replaced the one a drain read for nothing from that drain', async () => {
  const ctx = setupTest();
  const first = { sendEvent: mock() };
  const second = { sendEvent: mock() };

  ctx.taps.attach(toSessionID('s-shown'), first, true);

  const drain = drainInbox(toSessionID('s-shown'), ctx.source);

  await ctx.reading;

  ctx.taps.attach(toSessionID('s-shown'), second, true);

  ctx.read([
    {
      id: toMessageID('m-1'),
      atcID: toSessionID('s-shown'),
      from: 'owner',
      text: 'hello',
      status: 'accepted',
      sentAt: 0,
    },
  ]);

  await drain;

  expect(second.sendEvent).not.toHaveBeenCalled();
  expect(first.sendEvent).not.toHaveBeenCalled();
});

test("it sends an unlinked tap no message sent to another session's atc id", async () => {
  const ctx = setupTest();
  const tap = { sendEvent: mock() };

  ctx.taps.attach(toSessionID('s-shown'), tap, false);

  const drain = drainInbox(toSessionID('s-shown'), ctx.source);

  ctx.read([
    {
      id: toMessageID('m-hidden'),
      atcID: toSessionID('s-hidden'),
      agentSessionID: toAgentSessionID('a-shared'),
      from: 'owner',
      text: 'secret',
      status: 'accepted',
      sentAt: 0,
    },
    {
      id: toMessageID('m-own'),
      atcID: toSessionID('s-shown'),
      from: 'owner',
      text: 'hello',
      status: 'accepted',
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
