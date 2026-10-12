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
])('it normalizes %p to %p', (dir, expected) => {
  expect(normalizeConfigDir(dir, '/home/u')).toBe(expected);
});
