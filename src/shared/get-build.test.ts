import { expect, test } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { getBuild } from './get-build';

function setupTest() {
  const tmp = setupTempDir('atc-get-build-');

  // The walk needs a source tree with a module in two sibling directories.
  mkdirSync(join(tmp.dir, 'daemon'));
  mkdirSync(join(tmp.dir, 'shared'));
  writeFileSync(join(tmp.dir, 'daemon', 'sessions.ts'), '');
  writeFileSync(join(tmp.dir, 'shared', 'config.ts'), '');

  return { dir: tmp.dir, [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it changes the build string when a .ts file in a sibling directory changes', () => {
  using ctx = setupTest();

  const before = getBuild(ctx.dir);

  const future = new Date(Date.now() + 60_000);

  utimesSync(join(ctx.dir, 'daemon', 'sessions.ts'), future, future);

  expect(getBuild(ctx.dir)).not.toBe(before);
});

test('it keeps the build string when a file that is not .ts changes', () => {
  using ctx = setupTest();

  const before = getBuild(ctx.dir);

  const future = new Date(Date.now() + 60_000);

  writeFileSync(join(ctx.dir, 'daemon', 'notes.md'), '');
  utimesSync(join(ctx.dir, 'daemon', 'notes.md'), future, future);

  expect(getBuild(ctx.dir)).toBe(before);
});
