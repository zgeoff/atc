import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from '@zgeoff/testing/bin';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';
import { buildStubSignedInGH } from './build-stub-signed-in-gh';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-stub-signed-in-gh-');
  const gh = createStubBin(temporaryDirectory.path, 'gh', { script: buildStubSignedInGH() }).path;

  return { directory: temporaryDirectory.path, gh };
}

test('it prints https for the git protocol', async () => {
  const ctx = setupTest();

  const result = await run([ctx.gh, 'config', 'get', 'git_protocol'], {
    env: { HOME: ctx.directory, PATH: '/usr/bin:/bin' },
  });

  expect(result.stdout).toBe('https\n');
});

test("it answers the API's list of the signed-in account's repositories with one public repository", async () => {
  const ctx = setupTest();

  const result = await run([ctx.gh, 'api', 'user/repos?affiliation=owner&per_page=100&page=1'], {
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

test("it lists an owner's one private repository", async () => {
  const ctx = setupTest();

  const result = await run(
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
    { env: { HOME: ctx.directory, PATH: '/usr/bin:/bin' } },
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

  await run([ctx.gh, 'repo', 'list', '--limit', '100'], {
    env: { HOME: ctx.directory, PATH: '/usr/bin:/bin' },
  });

  await run([ctx.gh, 'config', 'get', 'git_protocol'], {
    env: { HOME: ctx.directory, PATH: '/usr/bin:/bin' },
  });

  expect(readFileSync(join(ctx.directory, 'gh-argv'), 'utf8')).toBe(
    'repo list --limit 100\nconfig get git_protocol\n',
  );
});
