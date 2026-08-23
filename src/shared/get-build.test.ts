import { expect, onTestFinished, test } from 'bun:test';
import { statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { getBuild } from './get-build';

test('it changes the build string when a .ts file in a sibling directory changes', () => {
  const target = join(import.meta.dir, '..', 'daemon', 'sessions.ts');
  const original = statSync(target);

  onTestFinished(() => {
    utimesSync(target, original.atime, original.mtime);
  });

  const before = getBuild();

  // One second past the newest mtime in the tree is enough to move the
  // stamp, and an interrupted run leaves the file stale for a second rather
  // than pinning the build string for an hour.
  const future = new Date(Math.max(Date.now(), original.mtime.getTime()) + 1000);

  utimesSync(target, future, future);

  const after = getBuild();

  expect(after).not.toBe(before);
});
