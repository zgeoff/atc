import { expect, test } from 'bun:test';
import { buildWorkspaceRootDir } from './build-workspace-root-dir';

test.each([
  { root: null, remote: false, expected: '/home/baker/.local/share/atc/workspaces' },
  { root: null, remote: true, expected: '.local/share/atc/workspaces' },
  { root: '/srv/work/', remote: false, expected: '/srv/work/' },
  { root: '~/code', remote: false, expected: '/home/baker/code' },
  { root: '~', remote: true, expected: '' },
])('it builds $expected from the root $root on a remote target: $remote', (row) => {
  expect(buildWorkspaceRootDir({ root: row.root, remote: row.remote, home: '/home/baker' })).toBe(
    row.expected,
  );
});

test.each([
  { root: 'code', message: /must be an absolute path or start with ~\//u },
  { root: '~/../elsewhere', message: /must stay under the home directory/u },
])('it refuses the root $root', (row) => {
  expect(() =>
    buildWorkspaceRootDir({ root: row.root, remote: false, home: '/home/baker' }),
  ).toThrow(row.message);
});
