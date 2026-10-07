import { expect, test } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { getBuild } from './get-build';

function setupTest() {
  const tmp = setupTempDir('atc-get-build-');

  return { dir: tmp.dir, [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it changes the build string when a .ts file in a sibling directory changes', () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.dir, 'daemon'));
  mkdirSync(join(ctx.dir, 'shared'));
  writeFileSync(join(ctx.dir, 'daemon', 'sessions.ts'), '');
  writeFileSync(join(ctx.dir, 'shared', 'config.ts'), '');

  const before = getBuild(ctx.dir);

  const future = new Date(Date.now() + 60_000);

  utimesSync(join(ctx.dir, 'daemon', 'sessions.ts'), future, future);

  expect(getBuild(ctx.dir)).not.toBe(before);
});

test('it keeps the build string when a file that is not .ts changes', () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.dir, 'daemon'));
  writeFileSync(join(ctx.dir, 'daemon', 'sessions.ts'), '');
  writeFileSync(join(ctx.dir, 'daemon', 'notes.md'), '');

  const before = getBuild(ctx.dir);

  const future = new Date(Date.now() + 60_000);

  utimesSync(join(ctx.dir, 'daemon', 'notes.md'), future, future);

  expect(getBuild(ctx.dir)).toBe(before);
});

test('it walks the src tree of its own checkout when no root is passed', () => {
  expect(getBuild()).toBe(getBuild(join(import.meta.dir, '..')));
});
