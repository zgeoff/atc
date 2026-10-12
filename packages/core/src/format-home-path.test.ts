import { expect, test } from 'bun:test';
import { formatHomePath } from './format-home-path';

test.each([
  ['/home/a', '~'],
  ['/home/a/src', '~/src'],
  ['/home/ab', '/home/ab'],
  ['/srv/x', '/srv/x'],
])('it formats %s as %s', (path, expected) => {
  expect(formatHomePath(path, '/home/a')).toBe(expected);
});
