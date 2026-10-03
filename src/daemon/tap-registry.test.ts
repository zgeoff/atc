import { expect, test } from 'bun:test';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import { TapRegistry } from './tap-registry';

test('it counts a session as tapped once a client attaches', () => {
  const taps = new TapRegistry<{ name: string }>();

  const session = toSessionID('s1');

  taps.attach(session, { name: 'a' });

  expect(taps.hasTap(session)).toBe(true);
  expect(taps.hasTap(toSessionID('s2'))).toBe(false);
});

test('it hands a message to the tap only once', () => {
  const taps = new TapRegistry<{ name: string }>();

  const session = toSessionID('s1');
  const client = { name: 'a' };

  taps.attach(session, client);

  const generation = taps.findTap(session)?.generation ?? 0;

  expect(taps.claimDelivery(session, toMessageID('m-1'), generation)).toBe(client);
  expect(taps.claimDelivery(session, toMessageID('m-1'), generation)).toBeNull();
});

test('it hands every message again to a tap that replaces the previous one', () => {
  const taps = new TapRegistry<{ name: string }>();

  const session = toSessionID('s1');
  const replacement = { name: 'b' };

  taps.attach(session, { name: 'a' });
  taps.claimDelivery(session, toMessageID('m-1'), taps.findTap(session)?.generation ?? 0);
  taps.attach(session, replacement);

  expect(
    taps.claimDelivery(session, toMessageID('m-1'), taps.findTap(session)?.generation ?? 0),
  ).toBe(replacement);
});

test('it refuses a delivery made for a tap that another attach replaced', () => {
  const taps = new TapRegistry<{ name: string }>();

  const session = toSessionID('s1');

  taps.attach(session, { name: 'a' }, true);

  const stale = taps.findTap(session)?.generation ?? 0;

  taps.attach(session, { name: 'b' }, false);

  expect(taps.claimDelivery(session, toMessageID('m-1'), stale)).toBeNull();
  expect(taps.findTap(session)).toStrictEqual({ generation: stale + 1, linked: false });
});

test('it gives a session to the latest tapping client', () => {
  const taps = new TapRegistry<{ name: string }>();

  const session = toSessionID('s1');
  const first = { name: 'a' };
  const second = { name: 'b' };

  taps.attach(session, first);
  taps.attach(session, second);

  expect(taps.isTap(session, first)).toBe(false);
  expect(taps.isTap(session, second)).toBe(true);
});

test('it drops every tap a closing client held', () => {
  const taps = new TapRegistry<{ name: string }>();

  const closing = { name: 'a' };
  const staying = { name: 'b' };

  taps.attach(toSessionID('s1'), closing);
  taps.attach(toSessionID('s2'), closing);
  taps.attach(toSessionID('s3'), staying);
  taps.detachAll(closing);

  expect(taps.hasTap(toSessionID('s1'))).toBe(false);
  expect(taps.hasTap(toSessionID('s2'))).toBe(false);
  expect(taps.hasTap(toSessionID('s3'))).toBe(true);
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

  expect(taps.hasTap(session)).toBe(false);
});

test('it returns the client a new tap displaces', () => {
  const taps = new TapRegistry<{ name: string }>();

  const session = toSessionID('s1');
  const first = { name: 'a' };

  expect(taps.attach(session, first)).toBeNull();
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
  expect(taps.removeSession(session)).toBeNull();
});
