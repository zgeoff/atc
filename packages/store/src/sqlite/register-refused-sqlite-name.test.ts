import { expect, onTestFinished, test } from 'bun:test';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import {
  registerRefusedSQLiteName,
  requireOpenableSQLitePath,
} from './register-refused-sqlite-name';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-refused-sqlite-');

  return { directory: temporaryDirectory.path };
}

test('it refuses a path whose file name is registered', () => {
  const ctx = setupTest();

  onTestFinished(registerRefusedSQLiteName('refused.db'));

  expect(() => {
    requireOpenableSQLitePath(join(ctx.directory, 'refused.db'));
  }).toThrow(
    expect.objectContaining({
      code: 'sqlite_refused',
      message: `atc: this process never opens refused.db, so it refuses ${join(ctx.directory, 'refused.db')}`,
    }),
  );
});

test('it refuses the registered name written in another case', () => {
  const ctx = setupTest();

  onTestFinished(registerRefusedSQLiteName('refused.db'));

  expect(() => {
    requireOpenableSQLitePath(join(ctx.directory, 'REFUSED.DB'));
  }).toThrow(expect.objectContaining({ code: 'sqlite_refused' }));
});

test('it refuses a symlink to a file with the registered name', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'refused.db'), '');
  symlinkSync(join(ctx.directory, 'refused.db'), join(ctx.directory, 'other.db'));
  onTestFinished(registerRefusedSQLiteName('refused.db'));

  expect(() => {
    requireOpenableSQLitePath(join(ctx.directory, 'other.db'));
  }).toThrow(expect.objectContaining({ code: 'sqlite_refused' }));
});

test('it refuses a symlink to a missing file with the registered name', () => {
  const ctx = setupTest();

  symlinkSync(join(ctx.directory, 'refused.db'), join(ctx.directory, 'other.db'));
  onTestFinished(registerRefusedSQLiteName('refused.db'));

  expect(() => {
    requireOpenableSQLitePath(join(ctx.directory, 'other.db'));
  }).toThrow(expect.objectContaining({ code: 'sqlite_refused' }));
});

test('it allows a path with another file name', () => {
  const ctx = setupTest();

  onTestFinished(registerRefusedSQLiteName('refused.db'));

  expect(() => {
    requireOpenableSQLitePath(join(ctx.directory, 'state.db'));
  }).not.toThrow();
});

test('it allows the registered name again once the release runs', () => {
  const ctx = setupTest();
  const release = registerRefusedSQLiteName('refused.db');

  release();

  expect(() => {
    requireOpenableSQLitePath(join(ctx.directory, 'refused.db'));
  }).not.toThrow();
});
