import { expect, test } from 'bun:test';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import { TapRegistry } from './tap-registry';

test('it counts a session as tapped once a client attaches', () => {
  const taps = new TapRegistry<{ name: string }>();

  taps.attach(toSessionID('s1'), { name: 'a' });

  expect({
    tapped: taps.hasTap(toSessionID('s1')),
    other: taps.hasTap(toSessionID('s2')),
  }).toStrictEqual({ tapped: true, other: false });
});

test('it hands a message to the tap', () => {
  const taps = new TapRegistry<{ name: string }>();

  const session = toSessionID('s1');
  const client = { name: 'a' };

  taps.attach(session, client);

  const tap = taps.findTap(session);

  if (tap === null) {
    throw new Error('expected a tap');
  }

  expect(taps.claimDelivery(session, toMessageID('m-1'), tap.generation)).toBe(client);
});

test('it hands a message to the tap only once', () => {
  const taps = new TapRegistry<{ name: string }>();

  const session = toSessionID('s1');

  taps.attach(session, { name: 'a' });

  const tap = taps.findTap(session);

  if (tap === null) {
    throw new Error('expected a tap');
  }

  taps.claimDelivery(session, toMessageID('m-1'), tap.generation);

  expect(taps.claimDelivery(session, toMessageID('m-1'), tap.generation)).toBeNull();
});

test('it hands every message again to a tap that replaces the previous one', () => {
  const taps = new TapRegistry<{ name: string }>();

  const session = toSessionID('s1');
  const replacement = { name: 'b' };

  taps.attach(session, { name: 'a' });

  const first = taps.findTap(session);

  if (first === null) {
    throw new Error('expected a tap');
  }

  taps.claimDelivery(session, toMessageID('m-1'), first.generation);
  taps.attach(session, replacement);

  const second = taps.findTap(session);

  if (second === null) {
    throw new Error('expected a tap');
  }

  expect(taps.claimDelivery(session, toMessageID('m-1'), second.generation)).toBe(replacement);
});

test('it refuses a delivery made for a tap that another attach replaced', () => {
  const taps = new TapRegistry<{ name: string }>();

  const session = toSessionID('s1');

  taps.attach(session, { name: 'a' }, true);

  const stale = taps.findTap(session);

  if (stale === null) {
    throw new Error('expected a tap');
  }

  taps.attach(session, { name: 'b' }, false);

  expect(taps.claimDelivery(session, toMessageID('m-1'), stale.generation)).toBeNull();
});

test('it gives a tap that replaces another the next generation and its own link', () => {
  const taps = new TapRegistry<{ name: string }>();

  const session = toSessionID('s1');

  taps.attach(session, { name: 'a' }, true);

  const stale = taps.findTap(session);

  if (stale === null) {
    throw new Error('expected a tap');
  }

  taps.attach(session, { name: 'b' }, false);

  expect(taps.findTap(session)).toStrictEqual({ generation: stale.generation + 1, linked: false });
});

test('it gives a session to the latest tapping client', () => {
  const taps = new TapRegistry<{ name: string }>();

  const session = toSessionID('s1');
  const first = { name: 'a' };
  const second = { name: 'b' };

  taps.attach(session, first);
  taps.attach(session, second);

  expect({
    first: taps.isTap(session, first),
    second: taps.isTap(session, second),
  }).toStrictEqual({ first: false, second: true });
});

test('it drops every tap a closing client held', () => {
  const taps = new TapRegistry<{ name: string }>();

  const closing = { name: 'a' };
  const staying = { name: 'b' };

  taps.attach(toSessionID('s1'), closing);
  taps.attach(toSessionID('s2'), closing);
  taps.attach(toSessionID('s3'), staying);
  taps.detachAll(closing);

  expect({
    s1: taps.hasTap(toSessionID('s1')),
    s2: taps.hasTap(toSessionID('s2')),
    s3: taps.hasTap(toSessionID('s3')),
  }).toStrictEqual({ s1: false, s2: false, s3: true });
});

test('it returns no client to claim for an untapped session', () => {
  const taps = new TapRegistry<{ name: string }>();

  expect(taps.claimDelivery(toSessionID('s1'), toMessageID('m-1'), 1)).toBeNull();
});

test('it forgets the tap of a removed session', () => {
  const taps = new TapRegistry<{ name: string }>();

  const session = toSessionID('s1');

  taps.attach(session, { name: 'a' });
  taps.removeSession(session);

  expect(taps.hasTap(session)).toBeFalse();
});

test('it displaces no one with the first tap', () => {
  const taps = new TapRegistry<{ name: string }>();

  expect(taps.attach(toSessionID('s1'), { name: 'a' })).toBeNull();
});

test('it returns the client a new tap displaces', () => {
  const taps = new TapRegistry<{ name: string }>();

  const session = toSessionID('s1');
  const first = { name: 'a' };

  taps.attach(session, first);

  expect(taps.attach(session, { name: 'b' })).toBe(first);
});

test('it displaces no one when the same client taps again', () => {
  const taps = new TapRegistry<{ name: string }>();

  const session = toSessionID('s1');
  const client = { name: 'a' };

  taps.attach(session, client);

  expect(taps.attach(session, client)).toBeNull();
});

test('it returns the client of a removed session', () => {
  const taps = new TapRegistry<{ name: string }>();

  const session = toSessionID('s1');
  const client = { name: 'a' };

  taps.attach(session, client);

  expect(taps.removeSession(session)).toBe(client);
});

test('it returns no client when a removed session is removed again', () => {
  const taps = new TapRegistry<{ name: string }>();

  const session = toSessionID('s1');

  taps.attach(session, { name: 'a' });
  taps.removeSession(session);

  expect(taps.removeSession(session)).toBeNull();
});
