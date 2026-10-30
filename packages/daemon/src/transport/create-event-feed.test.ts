import { expect, mock, test } from 'bun:test';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { toSessionID } from '@atcx/contract';
import { createEventFeed } from './create-event-feed';

test('it delivers the events collected before the subscription, in order', async () => {
  const feed = createEventFeed({
    capacity: 1024,
    canSeeOutput: () => true,
    resync: () => {},
    onOverflow: () => {},
  });

  feed.emit({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-1' });

  feed.emitOutput(
    toSessionID('s-2'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's-2', seq: 1, data: 'hi' },
    2,
  );

  const stream = feed.subscribe(new AbortController().signal);

  const first = await stream.next();
  const second = await stream.next();

  expect([first.value, second.value]).toStrictEqual([
    { ev: 'SessionRemoved', sessionID: 's-1' },
    { ev: 'SessionOutput', sessionID: 's-2', seq: 1, data: 'hi' },
  ]);
});

test('it drops what the backlog holds of a forgotten session and keeps the rest in order', async () => {
  const feed = createEventFeed({
    capacity: 1024,
    canSeeOutput: () => true,
    resync: () => {},
    onOverflow: () => {},
  });

  feed.emitOutput(
    toSessionID('s-gone'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's-gone', seq: 1, data: 'old' },
    3,
  );

  feed.emit({
    version: PROTOCOL_V,
    ev: 'SessionState',
    session: { id: 's-gone', name: 'gone' },
  });

  feed.emitOutput(
    toSessionID('s-kept'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's-kept', seq: 1, data: 'new' },
    3,
  );

  feed.forgetSession(toSessionID('s-gone'));
  feed.emit({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-gone' });

  const stream = feed.subscribe(new AbortController().signal);

  const first = await stream.next();
  const second = await stream.next();

  expect([first.value, second.value]).toStrictEqual([
    { ev: 'SessionOutput', sessionID: 's-kept', seq: 1, data: 'new' },
    { ev: 'SessionRemoved', sessionID: 's-gone' },
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

  feed.emit({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-3' });

  const delivered = await next;

  expect(delivered.value).toStrictEqual({ ev: 'SessionRemoved', sessionID: 's-3' });
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

  feed.emitOutput(
    s1,
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 1, data: 'a'.repeat(8) },
    8,
  );

  feed.emitOutput(
    s1,
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 2, data: 'b'.repeat(8) },
    8,
  );

  feed.emitOutput(
    s1,
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 3, data: 'c'.repeat(5) },
    5,
  );

  const stream = feed.subscribe(new AbortController().signal);

  const first = await stream.next();
  const second = await stream.next();

  expect([first.value, second.value]).toStrictEqual([
    { ev: 'SessionOutput', sessionID: 's1', seq: 1, data: 'a'.repeat(8) },
    { ev: 'SessionDesync', sessionID: 's1', dropped: 13 },
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

  feed.emitOutput(
    s1,
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 1, data: 'a'.repeat(8) },
    8,
  );

  feed.emitOutput(
    s1,
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 2, data: 'b'.repeat(8) },
    8,
  );

  const stream = feed.subscribe(new AbortController().signal);

  await stream.next();

  const next = stream.next();

  feed.emit({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's1' });

  const delivered = await next;

  expect(delivered.value).toStrictEqual({ ev: 'SessionRemoved', sessionID: 's1' });
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
  feed.emit({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-first-session' });
  feed.emit({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-second-session' });

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

  feed.emit({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-first-session' });
  feed.emit({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-second-session' });
  feed.emit({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-third' });

  const stream = feed.subscribe(new AbortController().signal);
  const next = stream.next();

  feed.emit({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-fourth' });

  const delivered = await next;

  expect(delivered.value).toStrictEqual({ ev: 'SessionRemoved', sessionID: 's-fourth' });
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
