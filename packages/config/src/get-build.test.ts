import { expect, test } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { getBuild } from './get-build';

function setupTest() {
  const tmp = setupTempDir('atc-get-build-');

  return { dir: tmp.dir };
}

test('it changes the build string when a .ts file in a nested directory changes', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'daemon'));
  mkdirSync(join(ctx.dir, 'shared'));
  writeFileSync(join(ctx.dir, 'daemon', 'sessions.ts'), '');
  writeFileSync(join(ctx.dir, 'shared', 'config.ts'), '');

  const before = getBuild({ version: '1.0.0', roots: [ctx.dir] });

  const future = new Date(Date.now() + 60_000);

  utimesSync(join(ctx.dir, 'daemon', 'sessions.ts'), future, future);

  expect(getBuild({ version: '1.0.0', roots: [ctx.dir] })).not.toBe(before);
});

test('it changes the build string when a .ts file in a second root changes', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'core'));
  mkdirSync(join(ctx.dir, 'app'));
  writeFileSync(join(ctx.dir, 'core', 'is-record.ts'), '');
  writeFileSync(join(ctx.dir, 'app', 'cli.ts'), '');

  const roots = [join(ctx.dir, 'app'), join(ctx.dir, 'core')];
  const before = getBuild({ version: '1.0.0', roots });

  const future = new Date(Date.now() + 60_000);

  utimesSync(join(ctx.dir, 'core', 'is-record.ts'), future, future);

  expect(getBuild({ version: '1.0.0', roots })).not.toBe(before);
});

test('it keeps the build string when a file that is not .ts changes', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'daemon'));
  writeFileSync(join(ctx.dir, 'daemon', 'sessions.ts'), '');
  writeFileSync(join(ctx.dir, 'daemon', 'notes.md'), '');

  const before = getBuild({ version: '1.0.0', roots: [ctx.dir] });

  const future = new Date(Date.now() + 60_000);

  utimesSync(join(ctx.dir, 'daemon', 'notes.md'), future, future);

  expect(getBuild({ version: '1.0.0', roots: [ctx.dir] })).toBe(before);
});

test('it skips a root that does not exist', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'cli.ts'), '');

  expect(getBuild({ version: '1.0.0', roots: [join(ctx.dir, 'gone'), ctx.dir] })).toBe(
    getBuild({ version: '1.0.0', roots: [ctx.dir] }),
  );
});

test('it starts the build string with the version', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'cli.ts'), '');

  expect(getBuild({ version: '4.2.0', roots: [ctx.dir] })).toStartWith('atc/4.2.0+');
});
