import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubHeldGH } from './build-stub-held-gh';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-stub-held-gh-'));
  const gh = createStubBin(tmp.dir, 'gh', buildStubHeldGH());
  const owned = stack.move();

  return {
    dir: tmp.dir,
    gh,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it prints https for the git protocol', () => {
  using ctx = setupTest();

  const result = Bun.spawnSync([ctx.gh, 'config', 'get', 'git_protocol'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
  });

  expect(result.stdout.toString()).toBe('https\n');
});

test('it lists one repository at once when no hold file exists', () => {
  using ctx = setupTest();

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
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'gh-hold'), '');

  const proc = Bun.spawn([ctx.gh, 'repo', 'list'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
    stdout: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  await waitFor(() => {
    expect(existsSync(join(ctx.dir, 'gh-held'))).toBe(true);
  });

  const exitedWhileHeld = proc.exitCode;

  rmSync(join(ctx.dir, 'gh-hold'));

  const exitCode = await proc.exited;

  expect({ exitedWhileHeld, exitCode }).toStrictEqual({ exitedWhileHeld: null, exitCode: 0 });
});
