import { expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubHeldGH } from './build-stub-held-gh';
import { createStubBin } from './create-stub-bin';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  const tmp = setupTempDir('atc-stub-held-gh-');
  const gh = createStubBin(tmp.dir, 'gh', buildStubHeldGH());

  return {
    dir: tmp.dir,
    gh,
  };
}

test('it prints https for the git protocol', () => {
  const ctx = setupTest();

  const result = Bun.spawnSync([ctx.gh, 'config', 'get', 'git_protocol'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
  });

  expect(result.stdout.toString()).toBe('https\n');
});

test('it lists one repository at once when no hold file exists', () => {
  const ctx = setupTest();

  const result = Bun.spawnSync([ctx.gh, 'repo', 'list', '--limit', '100'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
  });

  expect(JSON.parse(result.stdout.toString())).toStrictEqual([
    {
      nameWithOwner: 'me/dots',
      description: 'dotfiles',
      isPrivate: false,
      url: 'https://github.com/me/dots',
      sshUrl: 'git@github.com:me/dots.git',
    },
  ]);
});

test('it holds the listing until the hold file goes', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'gh-hold'), '');

  const proc = Bun.spawn([ctx.gh, 'repo', 'list'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    proc.kill();
  });

  await waitFor(() => {
    expect(existsSync(join(ctx.dir, 'gh-held'))).toBe(true);
  });

  const statusWhileHeld = Bun.peek.status(proc.exited);

  rmSync(join(ctx.dir, 'gh-hold'));

  const exitCode = await proc.exited;

  expect(statusWhileHeld).toBe('pending');
  expect(exitCode).toBe(0);
});
