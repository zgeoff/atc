import { expect, test } from 'bun:test';
import { findPeerMethod } from './find-peer-method';

test('it finds the method a peer request asks for', () => {
  expect(findPeerMethod('{"i":"0","p":{"u":"/daemon/hello","b":{"json":{}}}}')).toBe(
    'daemon.hello',
  );
});

test('it finds the method of a request whose type is given', () => {
  expect(findPeerMethod('{"i":"1","t":1,"p":{"u":"/session/auth/revoke"}}')).toBe(
    'session.auth.revoke',
  );
});

test.each([
  ['an abort', '{"i":"1","t":4}'],
  ['a stream event', '{"i":"1","t":3,"p":{"e":"message","d":{}}}'],
  ['a line-protocol request', '{"v":4,"id":1,"m":"daemon.hello"}'],
  ['a line that does not parse', 'not json'],
])('it finds no method in %s', (_label, line) => {
  expect(findPeerMethod(line)).toBeNull();
});
