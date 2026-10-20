import { expect, test } from 'bun:test';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import { buildStubWaitClock } from './build-stub-wait-clock';
import { waitForEvent } from './wait-for-event';

test('it resolves with an event collected before the wait began', async () => {
  const events: EventMsg[] = [{ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-1' }];

  const found = await waitForEvent(events, { ev: 'SessionRemoved' });

  expect(found).toStrictEqual({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-1' });
});

test('it resolves with an event collected while it waits', async () => {
  const events: EventMsg[] = [];

  // The event arrives during the wait after the first attempt misses.
  const found = await waitForEvent(
    events,
    { ev: 'SessionRemoved' },
    {
      wait: () => {
        events.push({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-2' });

        return Promise.resolve();
      },
    },
  );

  expect(found).toStrictEqual({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-2' });
});

test('it matches nested fields partially and resolves with the first match', async () => {
  const events: EventMsg[] = [
    { version: PROTOCOL_V, ev: 'SessionState', session: { id: 's-1', state: 'running' } },
    {
      version: PROTOCOL_V,
      ev: 'SessionState',
      session: { id: 's-1', state: 'needs_you', lastMsg: 'first' },
    },
    {
      version: PROTOCOL_V,
      ev: 'SessionState',
      session: { id: 's-1', state: 'needs_you', lastMsg: 'second' },
    },
  ];

  const found = await waitForEvent(events, { ev: 'SessionState', session: { state: 'needs_you' } });

  expect(found).toStrictEqual({
    version: PROTOCOL_V,
    ev: 'SessionState',
    session: { id: 's-1', state: 'needs_you', lastMsg: 'first' },
  });
});

test('it takes asymmetric matchers in the shape', async () => {
  const events: EventMsg[] = [
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's-1', data: 'GOT:hello\r\n', seq: 1 },
  ];

  const found = await waitForEvent(events, {
    ev: 'SessionOutput',
    data: expect.stringContaining('GOT:hello'),
  });

  expect(found).toStrictEqual({
    version: PROTOCOL_V,
    ev: 'SessionOutput',
    sessionID: 's-1',
    data: 'GOT:hello\r\n',
    seq: 1,
  });
});

test('it leaves every collected event as it arrived', async () => {
  const events: EventMsg[] = [
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's-1', data: 'GOT:hello\r\n', seq: 1 },
    {
      version: PROTOCOL_V,
      ev: 'SessionOutput',
      sessionID: 's-1',
      data: 'GOT:hello again\r\n',
      seq: 2,
    },
  ];

  await waitForEvent(events, {
    ev: 'SessionOutput',
    seq: 2,
    data: expect.stringContaining('GOT:'),
  });

  expect(events).toStrictEqual([
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's-1', data: 'GOT:hello\r\n', seq: 1 },
    {
      version: PROTOCOL_V,
      ev: 'SessionOutput',
      sessionID: 's-1',
      data: 'GOT:hello again\r\n',
      seq: 2,
    },
  ]);
});

test('it rejects listing the shape and the events it saw once the deadline passes', () => {
  const events: EventMsg[] = [{ version: PROTOCOL_V, ev: 'SessionAdded', session: {} }];
  const clock = buildStubWaitClock();

  expect(
    waitForEvent(
      events,
      { ev: 'SessionRemoved' },
      { timeoutMs: 80, intervalMs: 10, now: clock.now, wait: clock.wait },
    ),
  ).rejects.toThrowWithMessage(
    Error,
    'no event matches {"ev":"SessionRemoved"}; got ["SessionAdded"]',
  );
});
