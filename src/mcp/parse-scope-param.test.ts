import { expect, test } from 'bun:test';
import type { GrantScope } from '../shared/grant-scope';
import { parseScopeParam } from './parse-scope-param';

test.each<[string | null, GrantScope[]]>([
  [null, ['read', 'message', 'spawn', 'kill']],
  ['', ['read', 'message', 'spawn', 'kill']],
  ['read', ['read']],
  ['kill  read', ['read', 'kill']],
])('it reads a scope parameter of %p as %p', (raw, scopes) => {
  expect(parseScopeParam(raw)).toStrictEqual(scopes);
});

test('it refuses a scope parameter with a value outside the four scopes', () => {
  expect(parseScopeParam('read admin')).toBeNull();
});
