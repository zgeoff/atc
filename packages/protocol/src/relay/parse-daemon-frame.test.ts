/* oxlint-disable id-length -- `t` and `v` are the relay's frame keys */
import { expect, test } from 'bun:test';
import type { DaemonFrame } from './daemon-frame';
import { formatRelayFrame } from './format-relay-frame';
import { parseDaemonFrame } from './parse-daemon-frame';

test.each<DaemonFrame>([
  { t: 'hello', v: 1, relay: 'r1', gen: 2, ack: 0 },
  { t: 'line', seq: 3, conn: 1, line: '{"a":1}' },
  { t: 'close', seq: 4, conn: 1 },
  { t: 'ack', ack: 7 },
])('it reads a $t frame it formatted', (frame) => {
  expect(parseDaemonFrame(formatRelayFrame(frame).trim())).toStrictEqual(frame);
});

test.each(['', 'sh: warning', '{"t":"hello"', '[]', '{"t":"nope"}', '{"t":"ack","ack":-1}'])(
  'it returns null for the text %j',
  (text) => {
    expect(parseDaemonFrame(text)).toBeNull();
  },
);

test('it returns null for a hello of another version', () => {
  expect(parseDaemonFrame('{"t":"hello","v":2,"relay":"r","gen":1,"ack":0}')).toBeNull();
});
