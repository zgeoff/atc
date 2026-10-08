import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { $ } from 'bun';
import { createGitFixture } from './create-git-fixture';
import { updateEnv } from './update-env';

test('it pushes the initial commit to the upstream main branch', async () => {
  await using fixture = await createGitFixture();

  const upstreamMain = await $`git rev-parse main`.env(fixture.env).cwd(fixture.upstream).text();

  expect(upstreamMain.trim()).toBe(fixture.sha);
});

test('it checks out the initial commit in the work clone', async () => {
  await using fixture = await createGitFixture();

  const log = await $`git log --format=%s%n%H`.env(fixture.env).cwd(fixture.work).text();

  expect([log, readFileSync(join(fixture.work, 'README.md'), 'utf8')]).toStrictEqual([
    `initial\n${fixture.sha}\n`,
    'hello\n',
  ]);
});

test('it points the work clone at its own upstream', async () => {
  await using fixture = await createGitFixture();

  const origin = await $`git remote get-url origin`.env(fixture.env).cwd(fixture.work).text();

  expect(origin.trim()).toBe(fixture.upstream);
});

test('it never pushes one fixture into another', async () => {
  await using first = await createGitFixture();
  await using second = await createGitFixture();

  writeFileSync(join(first.work, 'more.txt'), 'more\n');

  await $`git add more.txt`.env(first.env).cwd(first.work).quiet();
  await $`git commit --quiet -m more`.env(first.env).cwd(first.work).quiet();
  await $`git push --quiet origin main`.env(first.env).cwd(first.work).quiet();

  const secondMain = await $`git rev-parse main`.env(second.env).cwd(second.upstream).text();

  expect(secondMain.trim()).toBe(second.sha);
});

test('it commits as atc without signing', async () => {
  await using fixture = await createGitFixture();

  const settings = await $`git config --local --get-regexp ${'^(user|commit|tag)[.]'}`
    .env(fixture.env)
    .cwd(fixture.work)
    .text();

  expect(settings).toBe(
    'user.name atc\nuser.email atc@example.com\ncommit.gpgsign false\ntag.gpgsign false\n',
  );
});

test('it holds no git variable of the host in its env', async () => {
  updateEnv('GIT_DIR', '/nowhere');

  await using fixture = await createGitFixture();

  expect(Object.entries(fixture.env).filter(([name]) => name.startsWith('GIT_'))).toStrictEqual([
    ['GIT_CONFIG_NOSYSTEM', '1'],
    ['GIT_CONFIG_GLOBAL', '/dev/null'],
  ]);
});

test('it lays the upstream and the work clone out in its directory', async () => {
  await using fixture = await createGitFixture({ prefix: 'atc-layout-' });

  expect({
    name: basename(fixture.dir),
    upstream: fixture.upstream,
    work: fixture.work,
  }).toStrictEqual({
    name: expect.toStartWith('atc-layout-'),
    upstream: join(fixture.dir, 'upstream.git'),
    work: join(fixture.dir, 'work'),
  });
});

test('it removes its directory on dispose', async () => {
  const fixture = await createGitFixture();

  onTestFinished(() => fixture[Symbol.asyncDispose]());

  await fixture[Symbol.asyncDispose]();

  expect(existsSync(fixture.dir)).toBeFalse();
});

test('it refuses to build its template outside the test home', () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      "import { createGitFixture } from './create-git-fixture.ts'; await createGitFixture();",
    ],
    {
      cwd: import.meta.dir,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name !== 'ATC_TEST_HOME'),
      ),
    },
  );

  expect(result.stderr.toString()).toInclude(
    'a git fixture needs the test home; run `bun run test`',
  );
});

test('it removes its directory once the test finishes without a dispose', async () => {
  const fixture = await createGitFixture();

  onTestFinished(() => {
    expect(existsSync(fixture.dir)).toBeFalse();
  });
});

test('it removes its directory once when disposed before the test finishes', async () => {
  const fixture = await createGitFixture();

  await fixture[Symbol.asyncDispose]();

  expect(existsSync(fixture.dir)).toBeFalse();
});
