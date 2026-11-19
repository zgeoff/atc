/* oxlint-disable id-length -- `t` and `v` are the relay's frame keys */
import { expect, test } from 'bun:test';
import { formatRelayFrame } from './format-relay-frame';
import type { GuestFrame } from './guest-frame';
import { parseGuestFrame } from './parse-guest-frame';

test.each<GuestFrame>([
  { t: 'welcome', v: 1, relay: 'r1', gen: 2, ack: 0, reset: true },
  { t: 'open', seq: 1, conn: 1 },
  { t: 'line', seq: 2, conn: 1, line: 'hook' },
  { t: 'end', seq: 3, conn: 1 },
  { t: 'close', seq: 4, conn: 1 },
  { t: 'ack', ack: 2 },
])('it reads a $t frame it formatted', (frame) => {
  expect(parseGuestFrame(formatRelayFrame(frame).trim())).toStrictEqual(frame);
});

test.each(['', 'sh: warning', '{"t":"welcome"', '[]', '{"t":"nope"}', '{"t":"ack","ack":-1}'])(
  'it returns null for the text %j',
  (text) => {
    expect(parseGuestFrame(text)).toBeNull();
  },
);

test('it reports a welcome of another version as foreign', () => {
  expect(parseGuestFrame('{"t":"welcome","v":2,"relay":"r","gen":3}')).toStrictEqual({
    t: 'welcome',
    v: 2,
    relay: 'r',
    gen: 3,
  });
});
