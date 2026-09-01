import { expect, test } from 'bun:test';
import type { EventMsg } from '../src/protocol/protocol';
import { waitForEvent } from './wait-for-event';

test('it returns the first event that already matches', async () => {
  const events: EventMsg[] = [
    { v: 3, ev: 'SessionAdded' },
    { v: 3, ev: 'SessionRenamed' },
  ];

  const found = await waitForEvent(events, (event) => event.ev === 'SessionRenamed');

  expect(found).toStrictEqual({ v: 3, ev: 'SessionRenamed' });
});

test('it keeps polling until a matching event arrives', async () => {
  const events: EventMsg[] = [];
  const pending = waitForEvent(events, (event) => event.ev === 'SessionRemoved');

  // A poll observing the empty list leaves no signal; the settle spans a
  // few poll rounds so the wait proves polling, not a single scan.
  await Bun.sleep(60);

  events.push({ v: 3, ev: 'SessionRemoved' });

  const found = await pending;

  expect(found).toStrictEqual({ v: 3, ev: 'SessionRemoved' });
});

test('it throws listing the seen event names when the deadline passes first', () => {
  const events: EventMsg[] = [{ v: 3, ev: 'SessionAdded' }];

  expect(waitForEvent(events, () => false, 100)).rejects.toThrowWithMessage(
    Error,
    'no matching event; got ["SessionAdded"]',
  );
});
