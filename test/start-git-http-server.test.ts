import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { $ } from 'bun';
import { setupTempDir } from './setup-temp-dir';
import { startGitHTTPServer } from './start-git-http-server';

// A bare repository with one commit, served by the server under test, with
// the host's system and global git config kept out of every command.
async function setupTest() {
  const tmp = setupTempDir('atc-git-http-');

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };

  const upstream = join(tmp.dir, 'upstream.git');
  const work = join(tmp.dir, 'work');

  await $`git init --quiet --bare --template= --initial-branch=main ${upstream}`.env(env).quiet();
  await $`git clone --quiet --template= ${upstream} ${work}`.env(env).quiet();

  await $`git -c user.name=atc -c user.email=atc@example.com commit --quiet --allow-empty -m one`
    .env(env)
    .cwd(work)
    .quiet();

  await $`git push --quiet origin main`.env(env).cwd(work).quiet();

  const server = startGitHTTPServer(tmp.dir, env);

  onTestFinished(async () => {
    await server.stop();
  });

  return { env, dir: tmp.dir, server, [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it clones a served repository for a client that authenticates and records the header', async () => {
  using ctx = await setupTest();

  const url = new URL('upstream.git', ctx.server.url);

  url.username = 'x-access-token';
  url.password = 'fixture-not-a-secret';

  const clone = await $`git clone --quiet ${url.href} ${join(ctx.dir, 'clone')}`
    .env(ctx.env)
    .nothrow()
    .quiet();

  expect(clone.exitCode).toBe(0);
  expect(ctx.server.authorizations).not.toBeEmpty();

  expect(ctx.server.authorizations).toSatisfyAll(
    (header: string) =>
      header === `Basic ${Buffer.from('x-access-token:fixture-not-a-secret').toString('base64')}`,
  );
});

test('it refuses a client that does not authenticate', async () => {
  using ctx = await setupTest();

  const clone = await $`git clone --quiet ${`${ctx.server.url}upstream.git`} ${join(ctx.dir, 'c')}`
    .env(ctx.env)
    .nothrow()
    .quiet();

  expect(clone.exitCode).not.toBe(0);
  expect(ctx.server.authorizations).toStrictEqual([]);
});

test('it holds each authenticated request for the delay it is given', async () => {
  using ctx = await setupTest();

  const slow = startGitHTTPServer(ctx.dir, ctx.env, { delayMs: 400 });

  onTestFinished(async () => {
    await slow.stop();
  });

  const url = new URL('upstream.git', slow.url);

  url.username = 'x-access-token';
  url.password = 'fixture-not-a-secret';

  const started = Date.now();

  const listed = await $`git ls-remote ${url.href}`.env(ctx.env).nothrow().quiet();

  expect(listed.exitCode).toBe(0);
  expect(Date.now() - started).toBeGreaterThanOrEqual(400);
});
