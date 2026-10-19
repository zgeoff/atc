import { expect, mock, test } from 'bun:test';
import { toSessionID } from '@atc/core';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { createEventFeed } from './create-event-feed';

test('it delivers the events collected before the subscription, in order', async () => {
  const feed = createEventFeed({
    capacity: 1024,
    canSeeOutput: () => true,
    resync: () => {},
    onOverflow: () => {},
  });

  feed.emit({ v: PROTOCOL_V, ev: 'SessionRemoved', s: 's-1' });

  feed.emitOutput(
    toSessionID('s-2'),
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's-2', seq: 1, d: 'hi' },
    2,
  );

  const stream = feed.subscribe(new AbortController().signal);

  const first = await stream.next();
  const second = await stream.next();

  expect([first.value, second.value]).toStrictEqual([
    { ev: 'SessionRemoved', s: 's-1' },
    { ev: 'SessionOutput', s: 's-2', seq: 1, d: 'hi' },
  ]);
});

test('it delivers an event emitted while the subscriber waits', async () => {
  const feed = createEventFeed({
    capacity: 1024,
    canSeeOutput: () => true,
    resync: () => {},
    onOverflow: () => {},
  });

  const stream = feed.subscribe(new AbortController().signal);
  const next = stream.next();

  feed.emit({ v: PROTOCOL_V, ev: 'SessionRemoved', s: 's-3' });

  const delivered = await next;

  expect(delivered.value).toStrictEqual({ ev: 'SessionRemoved', s: 's-3' });
});

test('it drops overflowing output and reports the dropped bytes before the repaint', async () => {
  const resync = mock<(sessionID: string) => void>(() => {});

  const feed = createEventFeed({
    capacity: 10,
    canSeeOutput: () => true,
    resync,
    onOverflow: () => {},
  });

  const s1 = toSessionID('s1');

  feed.emitOutput(s1, { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', seq: 1, d: 'a'.repeat(8) }, 8);
  feed.emitOutput(s1, { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', seq: 2, d: 'b'.repeat(8) }, 8);
  feed.emitOutput(s1, { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', seq: 3, d: 'c'.repeat(5) }, 5);

  const stream = feed.subscribe(new AbortController().signal);

  const first = await stream.next();
  const second = await stream.next();

  expect([first.value, second.value]).toStrictEqual([
    { ev: 'SessionOutput', s: 's1', seq: 1, d: 'a'.repeat(8) },
    { ev: 'SessionDesync', s: 's1', dropped: 13 },
  ]);

  expect(resync).toHaveBeenCalledExactlyOnceWith(s1);
});

test('it reports no dropped output of a session the connection can no longer see', async () => {
  const resync = mock<(sessionID: string) => void>(() => {});

  const feed = createEventFeed({
    capacity: 10,
    canSeeOutput: () => false,
    resync,
    onOverflow: () => {},
  });

  const s1 = toSessionID('s1');

  feed.emitOutput(s1, { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', seq: 1, d: 'a'.repeat(8) }, 8);
  feed.emitOutput(s1, { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', seq: 2, d: 'b'.repeat(8) }, 8);

  const stream = feed.subscribe(new AbortController().signal);

  await stream.next();

  const next = stream.next();

  feed.emit({ v: PROTOCOL_V, ev: 'SessionRemoved', s: 's1' });

  const delivered = await next;

  expect(delivered.value).toStrictEqual({ ev: 'SessionRemoved', s: 's1' });
  expect(resync).not.toHaveBeenCalled();
});

test('it ends the connection when an event overflows the backlog of a subscribed feed', () => {
  const onOverflow = mock(() => {});

  const feed = createEventFeed({
    capacity: 40,
    canSeeOutput: () => true,
    resync: () => {},
    onOverflow,
  });

  feed.subscribe(new AbortController().signal);
  feed.emit({ v: PROTOCOL_V, ev: 'SessionRemoved', s: 's-first-session' });
  feed.emit({ v: PROTOCOL_V, ev: 'SessionRemoved', s: 's-second-session' });

  expect(onOverflow).toHaveBeenCalledOnce();
});

test('it stops collecting once the backlog fills before a subscriber comes', async () => {
  const onOverflow = mock(() => {});

  const feed = createEventFeed({
    capacity: 40,
    canSeeOutput: () => true,
    resync: () => {},
    onOverflow,
  });

  feed.emit({ v: PROTOCOL_V, ev: 'SessionRemoved', s: 's-first-session' });
  feed.emit({ v: PROTOCOL_V, ev: 'SessionRemoved', s: 's-second-session' });
  feed.emit({ v: PROTOCOL_V, ev: 'SessionRemoved', s: 's-third' });

  const stream = feed.subscribe(new AbortController().signal);
  const next = stream.next();

  feed.emit({ v: PROTOCOL_V, ev: 'SessionRemoved', s: 's-fourth' });

  const delivered = await next;

  expect(delivered.value).toStrictEqual({ ev: 'SessionRemoved', s: 's-fourth' });
  expect(onOverflow).not.toHaveBeenCalled();
});

test('it refuses a second subscription while the first runs', () => {
  const feed = createEventFeed({
    capacity: 1024,
    canSeeOutput: () => true,
    resync: () => {},
    onOverflow: () => {},
  });

  feed.subscribe(new AbortController().signal);

  expect(() => feed.subscribe(new AbortController().signal)).toThrow(
    expect.objectContaining({ code: 'bad_args' }),
  );
});

test('it ends the subscription when its signal aborts', async () => {
  const feed = createEventFeed({
    capacity: 1024,
    canSeeOutput: () => true,
    resync: () => {},
    onOverflow: () => {},
  });

  const controller = new AbortController();

  const stream = feed.subscribe(controller.signal);
  const next = stream.next();

  controller.abort();

  const ended = await next;

  expect(ended.done).toBeTrue();
});
