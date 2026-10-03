import { expect, test } from 'bun:test';
import type { EventMsg } from '../protocol/protocol';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import type { MessageRecord } from '../store/message-record';
import type { TapClient } from './daemon-context';
import { drainInbox } from './drain-inbox';
import { TapRegistry } from './tap-registry';

/**
 * A drain of session `s-shown`, whose tap `first` (linked or not) is in
 * place before the drain starts and whose pending-message read waits on a
 * deferred. `reading` settles once the read starts, and `read` resolves it
 * with the given messages. `first` and `second` each keep every event they
 * are sent; `second` taps nothing until a test attaches it.
 */
function setupTest(linked: boolean) {
  const taps = new TapRegistry<TapClient>();

  const pending = Promise.withResolvers<MessageRecord[]>();
  const reading = Promise.withResolvers<void>();
  const firstEvents: EventMsg[] = [];
  const secondEvents: EventMsg[] = [];

  const first = {
    events: firstEvents,
    client: { sendEvent: (e: EventMsg) => firstEvents.push(e) },
  };

  const second = {
    events: secondEvents,
    client: { sendEvent: (e: EventMsg) => secondEvents.push(e) },
  };

  taps.attach(toSessionID('s-shown'), first.client, linked);

  const drain = drainInbox(toSessionID('s-shown'), {
    taps,
    findLinkedOwner: () => ({
      atcID: toSessionID('s-shown'),
      agentSessionID: toAgentSessionID('a-shared'),
    }),
    collectPendingMessages: () => {
      reading.resolve();

      return pending.promise;
    },
  });

  return {
    taps,
    drain,
    first,
    second,
    reading: reading.promise,
    read: (records: readonly MessageRecord[]) => {
      pending.resolve([...records]);
    },
  };
}

test("it sends a principal's tap that replaced the owner's during the read no message the owner's read found", async () => {
  const scoped = setupTest(true);
  const principal = scoped.second;

  await scoped.reading;

  scoped.taps.attach(toSessionID('s-shown'), principal.client, false);

  scoped.read([
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

  await scoped.drain;

  expect(principal.events).toStrictEqual([]);
  expect(scoped.first.events).toStrictEqual([]);
});

test('it sends a tap that replaced the one a drain read for nothing from that drain', async () => {
  const scoped = setupTest(true);

  await scoped.reading;

  scoped.taps.attach(toSessionID('s-shown'), scoped.second.client, true);

  scoped.read([
    {
      id: toMessageID('m-1'),
      atcID: toSessionID('s-shown'),
      from: 'owner',
      text: 'hello',
      status: 'accepted',
      sentAt: 0,
    },
  ]);

  await scoped.drain;

  expect(scoped.second.events).toStrictEqual([]);
  expect(scoped.first.events).toStrictEqual([]);
});

test("it sends an unlinked tap no message sent to another session's atc id", async () => {
  const scoped = setupTest(false);

  await scoped.reading;

  scoped.read([
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

  await scoped.drain;

  expect(scoped.first.events).toStrictEqual([
    {
      v: 4,
      ev: 'InboxMessage',
      s: 's-shown',
      message: 'm-own',
      from: 'owner',
      text: 'hello',
      sentAt: 1,
    },
  ]);
});
