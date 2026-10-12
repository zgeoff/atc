import { expect, test } from 'bun:test';
import { buildUnmarkedText } from './build-unmarked-text';

test('it drops every opening and closing paste marker', () => {
  expect(buildUnmarkedText('a\u001B[201~b\u001B[200~c\u001B[201~')).toBe('abc');
});

test('it leaves text with no paste marker unchanged', () => {
  expect(buildUnmarkedText('/model opus\n')).toBe('/model opus\n');
});
