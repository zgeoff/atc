import { expect, test } from 'bun:test';
import { toPeerMethod } from './to-peer-method';

test('it joins a procedure path with dots', () => {
  expect(toPeerMethod('/session/scope/add')).toBe('session.scope.add');
});

test.each([
  ['a trailing slash', '/daemon/quit/'],
  ['a doubled leading slash', '//daemon/quit'],
  ['a doubled inner slash', '/daemon//quit'],
  ['a dot segment', '/daemon/./quit'],
  ['a parent segment', '/session/../daemon/quit'],
  ['an encoded slash', '/daemon%2Fquit'],
  ['a dot in a name', '/daemon.quit'],
  ['no leading slash', 'daemon/quit'],
  ['an empty path', ''],
  ['the root alone', '/'],
])('it names no method for a path with %s', (_label, pathname) => {
  expect(toPeerMethod(pathname)).toBeNull();
});
