import { expect, test } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { readBuild } from './read-build';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-get-build-');

  return { directory: temporaryDirectory.path };
}

test('it changes the build string when a .ts file in a nested directory changes', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'daemon'));
  mkdirSync(join(ctx.directory, 'shared'));
  writeFileSync(join(ctx.directory, 'daemon', 'sessions.ts'), '');
  writeFileSync(join(ctx.directory, 'shared', 'config.ts'), '');

  const before = readBuild({ version: '1.0.0', roots: [ctx.directory] });

  const future = new Date(Date.now() + 60_000);

  utimesSync(join(ctx.directory, 'daemon', 'sessions.ts'), future, future);

  expect(readBuild({ version: '1.0.0', roots: [ctx.directory] })).not.toBe(before);
});

test('it changes the build string when a .ts file in a second root changes', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'core'));
  mkdirSync(join(ctx.directory, 'app'));
  writeFileSync(join(ctx.directory, 'core', 'is-record.ts'), '');
  writeFileSync(join(ctx.directory, 'app', 'cli.ts'), '');

  const roots = [join(ctx.directory, 'app'), join(ctx.directory, 'core')];
  const before = readBuild({ version: '1.0.0', roots });

  const future = new Date(Date.now() + 60_000);

  utimesSync(join(ctx.directory, 'core', 'is-record.ts'), future, future);

  expect(readBuild({ version: '1.0.0', roots })).not.toBe(before);
});

test('it keeps the build string when a file that is not .ts changes', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'daemon'));
  writeFileSync(join(ctx.directory, 'daemon', 'sessions.ts'), '');
  writeFileSync(join(ctx.directory, 'daemon', 'notes.md'), '');

  const before = readBuild({ version: '1.0.0', roots: [ctx.directory] });

  const future = new Date(Date.now() + 60_000);

  utimesSync(join(ctx.directory, 'daemon', 'notes.md'), future, future);

  expect(readBuild({ version: '1.0.0', roots: [ctx.directory] })).toBe(before);
});

test('it skips a root that does not exist', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'cli.ts'), '');

  expect(readBuild({ version: '1.0.0', roots: [join(ctx.directory, 'gone'), ctx.directory] })).toBe(
    readBuild({ version: '1.0.0', roots: [ctx.directory] }),
  );
});

test('it starts the build string with the version', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'cli.ts'), '');

  expect(readBuild({ version: '4.2.0', roots: [ctx.directory] })).toStartWith('atc/4.2.0+');
});
