import { expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubHeldGH } from './build-stub-held-gh';
import { createStubBin } from './create-stub-bin';
import { registerTestCleanup } from './register-test-cleanup';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-held-gh-');
  const gh = createStubBin(temporaryDirectory.path, 'gh', buildStubHeldGH());

  return {
    directory: temporaryDirectory.path,
    gh,
  };
}

test('it prints https for the git protocol', async () => {
  const ctx = setupTest();

  const result = await runCommand([ctx.gh, 'config', 'get', 'git_protocol'], {
    env: { HOME: ctx.directory, PATH: '/usr/bin:/bin' },
  });

  expect(result.stdout).toBe('https\n');
});

test('it lists one repository at once when no hold file exists', async () => {
  const ctx = setupTest();

  const result = await runCommand([ctx.gh, 'repo', 'list', '--limit', '100'], {
    env: { HOME: ctx.directory, PATH: '/usr/bin:/bin' },
  });

  expect(JSON.parse(result.stdout)).toStrictEqual([
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

  writeFileSync(join(ctx.directory, 'gh-hold'), '');

  const subprocess = Bun.spawn([ctx.gh, 'repo', 'list'], {
    env: { HOME: ctx.directory, PATH: '/usr/bin:/bin' },
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  await waitFor(() => {
    expect(existsSync(join(ctx.directory, 'gh-held'))).toBe(true);
  });

  const statusWhileHeld = Bun.peek.status(subprocess.exited);

  rmSync(join(ctx.directory, 'gh-hold'));

  const exitCode = await subprocess.exited;

  expect(statusWhileHeld).toBe('pending');
  expect(exitCode).toBe(0);
});
