import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubSignedInGH } from './build-stub-signed-in-gh';
import { createStubBin } from './create-stub-bin';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  const tmp = setupTempDir('atc-stub-signed-in-gh-');
  const gh = createStubBin(tmp.dir, 'gh', buildStubSignedInGH());

  return { dir: tmp.dir, gh };
}

test('it prints https for the git protocol', async () => {
  const ctx = setupTest();

  const result = await runCommand([ctx.gh, 'config', 'get', 'git_protocol'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
  });

  expect(result.stdout).toBe('https\n');
});

test("it lists the signed-in account's one public repository", async () => {
  const ctx = setupTest();

  const result = await runCommand(
    [
      ctx.gh,
      'repo',
      'list',
      '--limit',
      '100',
      '--json',
      'nameWithOwner,description,isPrivate,url,sshUrl',
    ],
    { env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' } },
  );

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

test("it lists an owner's one private repository", async () => {
  const ctx = setupTest();

  const result = await runCommand(
    [
      ctx.gh,
      'repo',
      'list',
      'acme',
      '--limit',
      '100',
      '--json',
      'nameWithOwner,description,isPrivate,url,sshUrl',
    ],
    { env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' } },
  );

  expect(JSON.parse(result.stdout)).toStrictEqual([
    {
      nameWithOwner: 'acme/app',
      description: '',
      isPrivate: true,
      url: 'https://github.com/acme/app',
      sshUrl: 'git@github.com:acme/app.git',
    },
  ]);
});

test('it records each command line it runs in the home', async () => {
  const ctx = setupTest();

  await runCommand([ctx.gh, 'repo', 'list', '--limit', '100'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
  });

  await runCommand([ctx.gh, 'config', 'get', 'git_protocol'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
  });

  expect(readFileSync(join(ctx.dir, 'gh-argv'), 'utf8')).toBe(
    'repo list --limit 100\nconfig get git_protocol\n',
  );
});
