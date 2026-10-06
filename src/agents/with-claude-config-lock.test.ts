import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { withClaudeConfigLock } from './with-claude-config-lock';

function setupTest() {
  return setupTempDir('atc-claude-lock-');
}

test('it holds the lock directory while the callback runs and removes it after', async () => {
  await using tmp = setupTest();

  const configPath = join(tmp.dir, '.claude.json');

  const held = await withClaudeConfigLock(configPath, () =>
    Promise.resolve(existsSync(`${configPath}.lock`)),
  );

  expect(held).toBeTrue();
  expect(existsSync(`${configPath}.lock`)).toBeFalse();
});

test('it removes the lock directory when the callback throws', async () => {
  await using tmp = setupTest();

  const configPath = join(tmp.dir, '.claude.json');
  const locked = withClaudeConfigLock(configPath, () => Promise.reject(new Error('boom')));

  expect(locked).rejects.toThrowWithMessage(Error, 'boom');

  await locked.catch(() => null);

  expect(existsSync(`${configPath}.lock`)).toBeFalse();
});

test('it takes over a lock its holder left stale', async () => {
  await using tmp = setupTest();

  const configPath = join(tmp.dir, '.claude.json');
  const lockPath = `${configPath}.lock`;

  const stale = new Date(Date.now() - 60_000);

  mkdirSync(lockPath);
  utimesSync(lockPath, stale, stale);

  const ran = await withClaudeConfigLock(configPath, () => Promise.resolve(true));

  expect(ran).toBeTrue();
  expect(existsSync(lockPath)).toBeFalse();
});
