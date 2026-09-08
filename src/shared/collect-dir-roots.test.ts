import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { collectDirRoots } from './collect-dir-roots';

test('it expands a leading tilde and trims trailing slashes from each root', () => {
  expect(collectDirRoots({ roots: ['~', '~/projects/', '/srv/work//'] })).toStrictEqual([
    homedir(),
    join(homedir(), 'projects'),
    '/srv/work',
  ]);
});

test('it drops entries that are not non-empty strings and keeps the rest', () => {
  expect(collectDirRoots({ roots: ['/a', 7, null, '', '/b'] })).toStrictEqual(['/a', '/b']);
});

test.each([[null], [undefined], ['~/projects'], [{ roots: '~/projects' }], [{}]])(
  'it collects no roots when the dirs value is %p',
  (raw) => {
    expect(collectDirRoots(raw)).toStrictEqual([]);
  },
);
