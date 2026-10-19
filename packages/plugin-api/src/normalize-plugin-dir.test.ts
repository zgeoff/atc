import { expect, test } from 'bun:test';
import { normalizePluginDir } from './normalize-plugin-dir';

test.each([
  ['/opt/plugins/band', '/opt/plugins/band'],
  ['/opt/plugins/band/', '/opt/plugins/band'],
  ['/opt//plugins///band', '/opt/plugins/band'],
  ['/opt/./plugins/./band', '/opt/plugins/band'],
  ['/opt/plugins/band..v2', '/opt/plugins/band..v2'],
  ['~/plugins/band', '/home/sam/plugins/band'],
  ['~/plugins/band/', '/home/sam/plugins/band'],
  ['~/', '/home/sam'],
])('it gives %s as %s', (dir, normalized) => {
  expect(normalizePluginDir(dir, '/home/sam')).toBe(normalized);
});

test('it gives a path under a home with a trailing slash without a doubled slash', () => {
  expect(normalizePluginDir('~/plugins/band', '/home/sam/')).toBe('/home/sam/plugins/band');
});
