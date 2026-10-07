import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { waitFor } from '../test-utils/wait-for';
import { withClaudeConfigLock } from './with-claude-config-lock';

function setupTest() {
  return setupTempDir('atc-claude-lock-');
}

test('it holds the lock directory while the callback runs and removes it after', async () => {
  await using ctx = setupTest();

  const configPath = join(ctx.dir, '.claude.json');

  const held = await withClaudeConfigLock(configPath, () =>
    Promise.resolve(existsSync(`${configPath}.lock`)),
  );

  expect(held).toBeTrue();
  expect(existsSync(`${configPath}.lock`)).toBeFalse();
});

test('it removes the lock directory when the callback throws', () => {
  using ctx = setupTest();

  const configPath = join(ctx.dir, '.claude.json');
  const locked = withClaudeConfigLock(configPath, () => Promise.reject(new Error('boom')));

  expect(locked).rejects.toThrowWithMessage(Error, 'boom');
  expect(existsSync(`${configPath}.lock`)).toBeFalse();
});

test('it takes over a lock its holder left stale', async () => {
  await using ctx = setupTest();

  const configPath = join(ctx.dir, '.claude.json');
  const lockPath = `${configPath}.lock`;

  const stale = new Date(Date.now() - 60_000);

  mkdirSync(lockPath);
  utimesSync(lockPath, stale, stale);

  const ran = await withClaudeConfigLock(configPath, () => Promise.resolve(true));

  expect(ran).toBeTrue();
  expect(existsSync(lockPath)).toBeFalse();
});

test('it keeps the lock fresh while a slow callback runs', async () => {
  await using ctx = setupTest();

  const configPath = join(ctx.dir, '.claude.json');
  const lockPath = `${configPath}.lock`;

  const ages = await withClaudeConfigLock(
    configPath,
    async () => {
      const created = statSync(lockPath).mtimeMs;

      const refreshed = await waitFor(() => {
        const current = statSync(lockPath).mtimeMs;

        expect(current).not.toBe(created);

        return current;
      });

      return { created, refreshed };
    },
    { refreshMs: 5 },
  );

  expect(ages.refreshed).toBeGreaterThan(ages.created);
});

test('it leaves a lock another holder took over in place on release', async () => {
  await using ctx = setupTest();

  const configPath = join(ctx.dir, '.claude.json');
  const lockPath = `${configPath}.lock`;

  await withClaudeConfigLock(configPath, () => {
    rmdirSync(lockPath);
    mkdirSync(lockPath);

    return Promise.resolve();
  });

  expect(existsSync(lockPath)).toBeTrue();
});

test('it creates a config folder that does not exist yet', async () => {
  await using ctx = setupTest();

  const configPath = join(ctx.dir, 'fresh', '.claude.json');

  const ran = await withClaudeConfigLock(configPath, () => Promise.resolve(true));

  expect(ran).toBeTrue();
  expect(existsSync(join(ctx.dir, 'fresh'))).toBeTrue();
});
