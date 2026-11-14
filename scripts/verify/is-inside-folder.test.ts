import { expect, test } from 'bun:test';
import { isInsideFolder } from './is-inside-folder.ts';

test.each([
  { path: '/tmp/atc-test-home-pear/runtime/atc-daemon.sock', inside: true },
  { path: '/tmp/atc-test-home-pear', inside: false },
  { path: '/tmp/atc-test-home-pearl/runtime/atc-daemon.sock', inside: false },
  { path: '/run/user/1000/atc-daemon.sock', inside: false },
])('it reads $path as inside the run home: $inside', (row) => {
  expect(isInsideFolder('/tmp/atc-test-home-pear', row.path)).toBe(row.inside);
});
