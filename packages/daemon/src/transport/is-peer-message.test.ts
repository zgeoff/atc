import { expect, test } from 'bun:test';
import { isPeerMessage } from './is-peer-message';

test.each([
  ['a request', '{"i":"0","p":{"u":"/daemon/hello","b":{"json":{}}}}'],
  ['a request to a path that names no procedure', '{"i":"3","p":{"u":"/daemon/ping/"}}'],
  ['an abort', '{"i":"1","t":4}'],
])('it takes %s as a peer message', (_label, line) => {
  expect(isPeerMessage(line)).toBeTrue();
});

test.each([
  ['a line-protocol request', '{"v":4,"id":1,"m":"daemon.hello"}'],
  ['a numeric message id', '{"i":1,"p":{"u":"/daemon/hello"}}'],
  ['a JSON array', '["i"]'],
  ['a line that does not parse', 'not json'],
])('it takes %s as no peer message', (_label, line) => {
  expect(isPeerMessage(line)).toBeFalse();
});
