import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { setupTempDir } from './setup-temp-dir';

interface GitFixtureConfig {
  // The temp directory's name prefix.
  readonly prefix?: string;
}

export async function createGitFixture(config: GitFixtureConfig = {}) {
  const env = buildGitEnv(process.env);

  const template = await resolveTemplate();

  const temporaryDirectory = setupTempDir(config.prefix ?? 'atc-git-fixture-');
  const upstream = join(temporaryDirectory.path, 'upstream.git');
  const work = join(temporaryDirectory.path, 'work');

  cpSync(template.directory, temporaryDirectory.path, { recursive: true });

  // The copied clone's config still holds the template's upstream as its
  // origin; it is pointed at this fixture's own upstream instead, so a push
  // never reaches the template or another fixture.
  const gitConfig = join(work, '.git', 'config');

  writeFileSync(
    gitConfig,
    readFileSync(gitConfig, 'utf8').replace(
      `url = ${join(template.directory, 'upstream.git')}`,
      `url = ${upstream}`,
    ),
  );

  return {
    directory: temporaryDirectory.path,
    env,
    upstream,
    work,
    sha: template.sha,
    remove: temporaryDirectory.teardown,
  };
}

function buildGitEnv(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return {
    // A git hook exports GIT_DIR and friends, which would point git at the repo
    // running the hook, and a system-wide Git LFS install adds a pre-push hook
    // that refuses the fixture; every git command a test adds runs with this env.
    ...Object.fromEntries(Object.entries(source).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
}

interface GitTemplate {
  readonly directory: string;
  readonly sha: string;
}

// The template pair, built once per process: each fixture copies it, which
// costs a copy instead of a run of git commands.
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

  const directory = mkdtempSync(join(home, 'git-fixture-template-'));
  const upstream = join(directory, 'upstream.git');
  const work = join(directory, 'work');

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

  return { directory, sha: head.trim() };
}
