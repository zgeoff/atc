import { expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from '@atc/core/test-utils/create-stub-bin';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { runCommand } from '@atc/core/test-utils/run-command';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { buildStubHeldGH } from './build-stub-held-gh';

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

test("it answers the API's repository list with one repository at once when no hold file exists", async () => {
  const ctx = setupTest();

  const result = await runCommand([ctx.gh, 'api', 'user/repos?per_page=100&page=1'], {
    env: { HOME: ctx.directory, PATH: '/usr/bin:/bin' },
  });

  expect(JSON.parse(result.stdout)).toStrictEqual([
    {
      full_name: 'me/dots',
      description: 'dotfiles',
      private: false,
      html_url: 'https://github.com/me/dots',
      ssh_url: 'git@github.com:me/dots.git',
    },
  ]);
});

test('it holds the listing until the hold file goes', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'gh-hold'), '');

  const subprocess = Bun.spawn([ctx.gh, 'api', 'user/repos?per_page=100&page=1'], {
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
