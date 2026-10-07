import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { setupTempDir } from './setup-temp-dir';

interface GitFixtureConfig {
  // The temp directory's name prefix.
  readonly prefix?: string;
}

/**
 * A bare upstream at `upstream.git` on branch `main` and a work clone of it
 * at `work`, both in a fresh temp directory, holding one pushed commit that
 * adds `README.md`. The clone commits as `atc <atc@example.com>` without
 * signing, and its origin is this fixture's own upstream. `sha` is that
 * commit's id, the same in every fixture. `env` is the process environment
 * without any `GIT_*` variable and with the host's system and global git
 * config switched off: a git hook exports `GIT_DIR` and friends, which
 * would point git at the repository running the hook, and a system-wide Git
 * LFS install adds a pre-push hook that refuses the fixture. Run every git
 * command a test adds with it.
 *
 * The first call in a process builds a template pair under the test home,
 * and each call copies it, so a fixture costs a copy instead of a run of
 * git commands. Disposal removes the directory; hold the result with
 * `await using`.
 */
export async function createGitFixture(config: GitFixtureConfig = {}) {
  const env = buildGitEnv(process.env);

  const template = await resolveTemplate();

  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir(config.prefix ?? 'atc-git-fixture-'));
  const upstream = join(tmp.dir, 'upstream.git');
  const work = join(tmp.dir, 'work');

  cpSync(template.dir, tmp.dir, { recursive: true });

  // The copied clone's config still holds the template's upstream as its
  // origin; it is pointed at this fixture's own upstream instead, so a push
  // never reaches the template or another fixture.
  const gitConfig = join(work, '.git', 'config');

  writeFileSync(
    gitConfig,
    readFileSync(gitConfig, 'utf8').replace(
      `url = ${join(template.dir, 'upstream.git')}`,
      `url = ${upstream}`,
    ),
  );

  const owned = stack.move();

  return {
    dir: tmp.dir,
    env,
    upstream,
    work,
    sha: template.sha,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

function buildGitEnv(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(Object.entries(source).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
}

interface GitTemplate {
  readonly dir: string;
  readonly sha: string;
}

// The template pair, built once per process.
let template: Promise<GitTemplate> | null = null;

function resolveTemplate(): Promise<GitTemplate> {
  template ??= createTemplate();

  return template;
}

// The template lives under the test home, which the test script removes
// when the run ends.
async function createTemplate(): Promise<GitTemplate> {
  const env = buildGitEnv(process.env);
  const home = process.env['ATC_TEST_HOME'];

  if (home === undefined) {
    throw new Error('a git fixture needs the test home; run `bun run test`');
  }

  const dir = mkdtempSync(join(home, 'git-fixture-template-'));
  const upstream = join(dir, 'upstream.git');
  const work = join(dir, 'work');

  await $`git init --quiet --bare --template= --initial-branch=main ${upstream}`.env(env).quiet();
  await $`git clone --quiet --template= ${upstream} ${work}`.env(env).quiet();
  await $`git config user.name atc`.env(env).cwd(work).quiet();
  await $`git config user.email atc@example.com`.env(env).cwd(work).quiet();
  await $`git config commit.gpgsign false`.env(env).cwd(work).quiet();
  await $`git config tag.gpgsign false`.env(env).cwd(work).quiet();

  writeFileSync(join(work, 'README.md'), 'hello\n');

  await $`git add README.md`.env(env).cwd(work).quiet();
  await $`git commit --quiet -m initial`.env(env).cwd(work).quiet();
  await $`git push --quiet origin main`.env(env).cwd(work).quiet();

  const head = await $`git rev-parse HEAD`.env(env).cwd(work).quiet().text();

  return { dir, sha: head.trim() };
}
