import { expect, test } from 'bun:test';
import { normalizeConfigDir } from './normalize-config-dir';

test.each([
  ['~', '/home/u'],
  ['~/work', '/home/u/work'],
  ['~/work/', '/home/u/work'],
  ['/srv/repos//', '/srv/repos'],
  ['/', '/'],
  ['relative/dir', 'relative/dir'],
  ['~other/dir', '~other/dir'],
])('it normalizes %p to %p', (directory, expected) => {
  expect(normalizeConfigDir(directory, '/home/u')).toBe(expected);
});
