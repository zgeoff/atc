import { expect, test } from 'bun:test';
import { findPluginDirProblem } from './find-plugin-dir-problem';

test.each([
  ['an absolute path', '/opt/plugins/band'],
  ['a path under the home', '~/plugins/band'],
  ['the home with a trailing slash', '~/'],
  ['a path with a trailing slash', '/opt/plugins/band/'],
  ['a path with a . segment', '/opt/./plugins/band'],
  ['a path with a doubled slash', '/opt//plugins/band'],
  ['a name that holds two dots', '/opt/plugins/band..v2'],
  ['a path of 4096 characters', `/${'p'.repeat(4095)}`],
])('it accepts %s', (_label, directory) => {
  expect(findPluginDirProblem(directory)).toBeNull();
});

test.each([
  ['an empty path', ''],
  ['a path with a newline', '/opt/plugins/band\n'],
  ['a path with an escape byte', '/opt/plugins/band\u001B[2J'],
  ['a path of 4097 characters', `/${'p'.repeat(4096)}`],
])('it refuses %s for its length or characters', (_label, directory) => {
  expect(findPluginDirProblem(directory)).toBe(
    'each pluginDirs entry must be 1 to 4096 characters without control characters',
  );
});

test.each([
  ['a relative path', 'plugins/band'],
  ['a path that starts with ./', './plugins/band'],
  ['a bare ~', '~'],
  ["another user's home", '~sam/plugins/band'],
  ['a path with a .. segment', '/opt/plugins/link/../band'],
  ['a home path with a .. segment', '~/plugins/../band'],
  ['a path that ends in ..', '/opt/plugins/..'],
])('it refuses %s for its form', (_label, directory) => {
  expect(findPluginDirProblem(directory)).toBe(
    `pluginDirs entry '${directory}' must be an absolute path or start with ~/, without a .. segment`,
  );
});
