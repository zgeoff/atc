import { expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitFixture } from '@atc/test-utils';
import { $ } from 'bun';
import { z } from 'zod';
import { writeDeleteOnlyPushMark } from './write-delete-only-push-mark';

// The clone's pre-push hook runs the repo's lefthook.yml with each check after
// the mark job swapped for an echo of its name, because the real checks need
// the whole repo and take minutes.
async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'delete-only-push-' });

  const root = join(import.meta.dir, '..');
  const lefthook = join(root, 'node_modules', '.bin', 'lefthook');
  const jobSchema = z.looseObject({ name: z.string(), run: z.string() });

  const configSchema = z.looseObject({
    'pre-push': z.looseObject({ jobs: z.array(jobSchema) }),
  });

  const configText = readFileSync(join(root, 'lefthook.yml'), 'utf8');
  const config = configSchema.parse(Bun.YAML.parse(configText));
  const [markJob, ...checks] = config['pre-push'].jobs;

  const jobs = [
    markJob,
    ...checks.map((check) => ({
      ...check,
      files: undefined,
      glob: undefined,
      exclude: undefined,
      run: `echo ran:${check.name}`,
    })),
  ];

  mkdirSync(join(fixture.work, 'scripts'));

  copyFileSync(
    join(root, 'scripts', 'write-delete-only-push-mark.ts'),
    join(fixture.work, 'scripts', 'write-delete-only-push-mark.ts'),
  );

  writeFileSync(
    join(fixture.work, 'lefthook.yml'),
    Bun.YAML.stringify({ 'pre-push': { ...config['pre-push'], jobs } }),
  );

  const env = {
    ...Object.fromEntries(
      Object.entries(fixture.env).filter(([name]) => !name.startsWith('LEFTHOOK')),
    ),
    LEFTHOOK_BIN: lefthook,
  };

  await $`${lefthook} install`.env(env).cwd(fixture.work).quiet();

  return {
    repo: fixture.work,
    env,
    checkNames: checks.map((check) => check.name),
    markPath: join(fixture.work, '.git', 'atc-delete-only-push'),
  };
}

test('it writes the mark for a push that deletes every ref', async () => {
  const ctx = await setupTest();

  await writeDeleteOnlyPushMark({
    cwd: ctx.repo,
    env: ctx.env,
    refs: [
      '(delete) 0000000000000000000000000000000000000000 refs/heads/old 1111111111111111111111111111111111111111',
      '(delete) 0000000000000000000000000000000000000000 refs/heads/older 2222222222222222222222222222222222222222',
      '',
    ].join('\n'),
  });

  expect(existsSync(ctx.markPath)).toBe(true);
});

test('it removes the mark for a push that also updates a branch', async () => {
  const ctx = await setupTest();

  writeFileSync(ctx.markPath, '');

  await writeDeleteOnlyPushMark({
    cwd: ctx.repo,
    env: ctx.env,
    refs: [
      '(delete) 0000000000000000000000000000000000000000 refs/heads/old 1111111111111111111111111111111111111111',
      'refs/heads/feature 3333333333333333333333333333333333333333 refs/heads/feature 0000000000000000000000000000000000000000',
      '',
    ].join('\n'),
  });

  expect(existsSync(ctx.markPath)).toBe(false);
});

test('it removes the mark for a push with no refs', async () => {
  const ctx = await setupTest();

  writeFileSync(ctx.markPath, '');

  await writeDeleteOnlyPushMark({ cwd: ctx.repo, env: ctx.env, refs: '' });

  expect(existsSync(ctx.markPath)).toBe(false);
});

test('it runs every pre-push check on a push of a branch', async () => {
  const ctx = await setupTest();

  await $`git switch --quiet -c feature`.env(ctx.env).cwd(ctx.repo).quiet();

  writeFileSync(join(ctx.repo, 'feature.ts'), 'export {};\n');

  await $`git add feature.ts`.env(ctx.env).cwd(ctx.repo).quiet();
  await $`git commit --quiet -m feature`.env(ctx.env).cwd(ctx.repo).quiet();

  const push = await $`git push origin feature 2>&1`.env(ctx.env).cwd(ctx.repo).nothrow().quiet();

  expect(push.exitCode).toBe(0);
  expect(push.text()).toIncludeMultiple(ctx.checkNames.map((name) => `ran:${name}`));
});

// lefthook takes a pre-push job's files from the checked-out branch, not from
// the pushed refs, and skips the job when that branch changes no file, so the
// delete runs from a branch with a commit of its own.
test('it skips every pre-push check and deletes the branch on a push that only deletes', async () => {
  const ctx = await setupTest();

  await $`git push --quiet origin HEAD:refs/heads/hotfix`.env(ctx.env).cwd(ctx.repo).quiet();
  await $`git switch --quiet -c feature`.env(ctx.env).cwd(ctx.repo).quiet();

  writeFileSync(join(ctx.repo, 'feature.ts'), 'export {};\n');

  await $`git add feature.ts`.env(ctx.env).cwd(ctx.repo).quiet();
  await $`git commit --quiet -m feature`.env(ctx.env).cwd(ctx.repo).quiet();

  const push = await $`git push origin --delete hotfix 2>&1`
    .env(ctx.env)
    .cwd(ctx.repo)
    .nothrow()
    .quiet();

  const remote = await $`git ls-remote --heads origin hotfix`.env(ctx.env).cwd(ctx.repo).text();

  expect(push.exitCode).toBe(0);
  expect(push.text()).not.toInclude('ran:');
  expect(remote).toBe('');
});
