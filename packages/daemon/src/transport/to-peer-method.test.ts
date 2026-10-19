import { expect, test } from 'bun:test';
import { toPeerMethod } from './to-peer-method';

test('it joins a procedure path with dots', () => {
  expect(toPeerMethod('/session/scope/add')).toBe('session.scope.add');
});
