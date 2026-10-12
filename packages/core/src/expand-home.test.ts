import { expect, test } from 'bun:test';
import { expandHome } from './expand-home';

test.each([
  ['~', '/home/a'],
  ['~/src', '/home/a/src'],
  ['~bob/src', '~bob/src'],
  ['/srv/x', '/srv/x'],
])('it expands %s to %s', (path, expected) => {
  expect(expandHome(path, '/home/a')).toBe(expected);
});
