import { expect, test } from 'bun:test';
import { PROTOCOL_V } from '../protocol/protocol';
import type { EventMsg } from '../protocol/protocol';
import { waitForEvent } from './wait-for-event';

test('it resolves with an event collected before the wait began', async () => {
  const events: EventMsg[] = [{ v: PROTOCOL_V, ev: 'SessionRemoved', s: 's-1' }];

  const found = await waitForEvent(events, { ev: 'SessionRemoved' });

  expect(found).toStrictEqual({ v: PROTOCOL_V, ev: 'SessionRemoved', s: 's-1' });
});

test('it resolves with an event collected while it waits', async () => {
  const events: EventMsg[] = [];

  setTimeout(() => {
    events.push({ v: PROTOCOL_V, ev: 'SessionRemoved', s: 's-2' });
  }, 40);

  const found = await waitForEvent(events, { ev: 'SessionRemoved' });

  expect(found).toStrictEqual({ v: PROTOCOL_V, ev: 'SessionRemoved', s: 's-2' });
});

test('it matches nested fields partially and resolves with the first match', async () => {
  const events: EventMsg[] = [
    { v: PROTOCOL_V, ev: 'SessionState', session: { id: 's-1', state: 'running' } },
    {
      v: PROTOCOL_V,
      ev: 'SessionState',
      session: { id: 's-1', state: 'needs_you', lastMsg: 'first' },
    },
    {
      v: PROTOCOL_V,
      ev: 'SessionState',
      session: { id: 's-1', state: 'needs_you', lastMsg: 'second' },
    },
  ];

  const found = await waitForEvent(events, { ev: 'SessionState', session: { state: 'needs_you' } });

  expect(found).toStrictEqual({
    v: PROTOCOL_V,
    ev: 'SessionState',
    session: { id: 's-1', state: 'needs_you', lastMsg: 'first' },
  });
});

test('it takes asymmetric matchers in the shape', async () => {
  const events: EventMsg[] = [
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's-1', d: 'GOT:hello\r\n', seq: 1 },
  ];

  const found = await waitForEvent(events, {
    ev: 'SessionOutput',
    d: expect.stringContaining('GOT:hello'),
  });

  expect(found).toStrictEqual({
    v: PROTOCOL_V,
    ev: 'SessionOutput',
    s: 's-1',
    d: 'GOT:hello\r\n',
    seq: 1,
  });
});

test('it leaves every collected event as it arrived', async () => {
  const events: EventMsg[] = [
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's-1', d: 'GOT:hello\r\n', seq: 1 },
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's-1', d: 'GOT:hello again\r\n', seq: 2 },
  ];

  await waitForEvent(events, { ev: 'SessionOutput', seq: 2, d: expect.stringContaining('GOT:') });

  expect(events).toStrictEqual([
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's-1', d: 'GOT:hello\r\n', seq: 1 },
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's-1', d: 'GOT:hello again\r\n', seq: 2 },
  ]);
});

test('it rejects listing the shape and the events it saw once the deadline passes', () => {
  const events: EventMsg[] = [{ v: PROTOCOL_V, ev: 'SessionAdded', session: {} }];

  expect(
    waitForEvent(events, { ev: 'SessionRemoved' }, { timeoutMs: 80, intervalMs: 10 }),
  ).rejects.toThrowWithMessage(
    Error,
    'no event matches {"ev":"SessionRemoved"}; got ["SessionAdded"]',
  );
});
