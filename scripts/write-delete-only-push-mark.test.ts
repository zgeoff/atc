import { expect, onTestFinished, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createGitFixture, registerTestCleanup, waitFor } from '@atc/test-utils';
import { $ } from 'bun';
import { spawn } from 'bun-pty';
import invariant from 'tiny-invariant';
import { z } from 'zod';
import { writeDeleteOnlyPushMark } from './write-delete-only-push-mark';

// The clone's pre-push hook runs the repo's lefthook.yml with each check
// between the mark job and the mark removal swapped for an echo of its name,
// because the real checks need the whole repo and take minutes.
async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'delete-only-push-' });

  const root = join(import.meta.dir, '..');
  const lefthook = join(root, 'node_modules', '.bin', 'lefthook');

  // A job that only adds fields to a baseline job of the same name has no run.
  const jobSchema = z.looseObject({ name: z.string(), run: z.string().optional() });

  const configSchema = z.looseObject({
    'pre-push': z.looseObject({ jobs: z.array(jobSchema) }),
  });

  const configText = readFileSync(join(root, 'lefthook.yml'), 'utf8');
  const config = configSchema.parse(Bun.YAML.parse(configText));
  const [markJob, ...laterJobs] = config['pre-push'].jobs;
  const removeJob = laterJobs.at(-1);
  const checks = laterJobs.slice(0, -1);

  invariant(markJob && removeJob);

  // A push with PUSH_GATE set waits here until that file exists, so two pushes can overlap.
  const gateJob = {
    name: 'gate',
    run: 'test -z "$PUSH_GATE" || { touch "$PUSH_GATE.reached"; while [ ! -f "$PUSH_GATE" ]; do sleep 0.05; done; }',
  };

  const jobs = [
    markJob,
    gateJob,
    ...checks.map((check) => ({
      ...check,
      files: undefined,
      glob: undefined,
      exclude: undefined,
      run: `echo ran:${check.name}`,
    })),
    removeJob,
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
    directory: fixture.directory,
    env,
    checkNames: checks.map((check) => check.name),
    marks: join(fixture.work, '.git', 'atc-delete-only-push'),
  };
}

test('it writes a mark named for the hook id for a push that deletes every ref', async () => {
  const ctx = await setupTest();

  await writeDeleteOnlyPushMark({
    cwd: ctx.repo,
    env: ctx.env,
    hookID: 4100,
    refs: [
      '(delete) 0000000000000000000000000000000000000000 refs/heads/old 1111111111111111111111111111111111111111',
      '(delete) 0000000000000000000000000000000000000000 refs/heads/older 2222222222222222222222222222222222222222',
      '',
    ].join('\n'),
  });

  expect(existsSync(join(ctx.marks, '4100'))).toBe(true);
});

test('it removes its own mark for a push that also updates a branch', async () => {
  const ctx = await setupTest();

  mkdirSync(ctx.marks);
  writeFileSync(join(ctx.marks, '4100'), '');

  await writeDeleteOnlyPushMark({
    cwd: ctx.repo,
    env: ctx.env,
    hookID: 4100,
    refs: [
      '(delete) 0000000000000000000000000000000000000000 refs/heads/old 1111111111111111111111111111111111111111',
      'refs/heads/feature 3333333333333333333333333333333333333333 refs/heads/feature 0000000000000000000000000000000000000000',
      '',
    ].join('\n'),
  });

  expect(existsSync(join(ctx.marks, '4100'))).toBe(false);
});

test('it removes its own mark for a push with no refs', async () => {
  const ctx = await setupTest();

  mkdirSync(ctx.marks);
  writeFileSync(join(ctx.marks, '4100'), '');

  await writeDeleteOnlyPushMark({ cwd: ctx.repo, env: ctx.env, hookID: 4100, refs: '' });

  expect(existsSync(join(ctx.marks, '4100'))).toBe(false);
});

test("it never removes the mark of a run that's still going", async () => {
  const ctx = await setupTest();

  const runningMark = join(ctx.marks, String(process.pid));

  mkdirSync(ctx.marks);
  writeFileSync(runningMark, '');

  await writeDeleteOnlyPushMark({
    cwd: ctx.repo,
    env: ctx.env,
    hookID: 4100,
    refs: '(delete) 0000000000000000000000000000000000000000 refs/heads/old 1111111111111111111111111111111111111111\n',
  });

  expect(existsSync(runningMark)).toBe(true);
});

test('it removes the mark of a run that has ended', async () => {
  const ctx = await setupTest();

  const ended = Bun.spawn(['true']);

  await ended.exited;

  const endedMark = join(ctx.marks, String(ended.pid));

  mkdirSync(ctx.marks);
  writeFileSync(endedMark, '');

  await writeDeleteOnlyPushMark({
    cwd: ctx.repo,
    env: ctx.env,
    hookID: 4100,
    refs: 'refs/heads/feature 3333333333333333333333333333333333333333 refs/heads/feature 0000000000000000000000000000000000000000\n',
  });

  expect(existsSync(endedMark)).toBe(false);
});

test("it runs every pre-push check while another run's mark is present", async () => {
  const ctx = await setupTest();

  await $`git switch --quiet -c feature`.env(ctx.env).cwd(ctx.repo).quiet();

  writeFileSync(join(ctx.repo, 'feature.ts'), 'export {};\n');
  mkdirSync(ctx.marks);
  writeFileSync(join(ctx.marks, '1'), '');

  await $`git add feature.ts`.env(ctx.env).cwd(ctx.repo).quiet();
  await $`git commit --quiet -m feature`.env(ctx.env).cwd(ctx.repo).quiet();

  const push = await $`git push origin feature 2>&1`.env(ctx.env).cwd(ctx.repo).nothrow().quiet();

  expect(push.exitCode).toBe(0);
  expect(push.text()).toIncludeMultiple(ctx.checkNames.map((name) => `ran:${name}`));
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

test('it runs every pre-push check on a hook run by hand from a terminal', async () => {
  const ctx = await setupTest();

  await $`git switch --quiet -c feature`.env(ctx.env).cwd(ctx.repo).quiet();

  writeFileSync(join(ctx.repo, 'feature.ts'), 'export {};\n');

  await $`git add feature.ts`.env(ctx.env).cwd(ctx.repo).quiet();
  await $`git commit --quiet -m feature`.env(ctx.env).cwd(ctx.repo).quiet();

  const output = { text: '' };
  const exit = Promise.withResolvers<number>();

  const pty = spawn(ctx.env.LEFTHOOK_BIN, ['run', 'pre-push'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: ctx.repo,
    env: Object.fromEntries(
      Object.entries(ctx.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });

  onTestFinished(() => {
    pty.kill();
  });

  pty.onData((data) => {
    output.text += data;
  });

  pty.onExit((event) => {
    exit.resolve(event.exitCode);
  });

  const exitCode = await exit.promise;

  expect(exitCode).toBe(0);
  expect(output.text).toIncludeMultiple(ctx.checkNames.map((name) => `ran:${name}`));
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

test('it leaves no mark behind after a push that only deletes', async () => {
  const ctx = await setupTest();

  await $`git push --quiet origin HEAD:refs/heads/hotfix`.env(ctx.env).cwd(ctx.repo).quiet();
  await $`git switch --quiet -c feature`.env(ctx.env).cwd(ctx.repo).quiet();

  writeFileSync(join(ctx.repo, 'feature.ts'), 'export {};\n');

  await $`git add feature.ts`.env(ctx.env).cwd(ctx.repo).quiet();
  await $`git commit --quiet -m feature`.env(ctx.env).cwd(ctx.repo).quiet();
  await $`git push --quiet origin --delete hotfix`.env(ctx.env).cwd(ctx.repo).quiet();

  expect(readdirSync(ctx.marks)).toStrictEqual([]);
});

test('it skips every pre-push check of a delete-only push that overlaps another', async () => {
  const ctx = await setupTest();

  const gate = join(ctx.directory, 'gate');

  await $`git push --quiet origin HEAD:refs/heads/hotfix HEAD:refs/heads/release`
    .env(ctx.env)
    .cwd(ctx.repo)
    .quiet();

  await $`git switch --quiet -c feature`.env(ctx.env).cwd(ctx.repo).quiet();

  writeFileSync(join(ctx.repo, 'feature.ts'), 'export {};\n');

  await $`git add feature.ts`.env(ctx.env).cwd(ctx.repo).quiet();
  await $`git commit --quiet -m feature`.env(ctx.env).cwd(ctx.repo).quiet();

  const held = Bun.spawn(['sh', '-c', 'git push origin --delete hotfix 2>&1'], {
    cwd: ctx.repo,
    env: { ...ctx.env, PUSH_GATE: gate },
    stdout: 'pipe',
  });

  // Killing the push would leave the gate loop of its hook running, so the
  // release opens the gate and waits for the whole push to end; it runs before
  // the fixture's directory goes, because it registers later.
  registerTestCleanup(async () => {
    writeFileSync(gate, '');

    await held.exited;
  });

  await waitFor(() => {
    expect(existsSync(`${gate}.reached`)).toBe(true);
  });

  await $`git push --quiet origin --delete release`.env(ctx.env).cwd(ctx.repo).quiet();

  writeFileSync(gate, '');

  const [heldOutput, heldExitCode] = await Promise.all([
    new Response(held.stdout).text(),
    held.exited,
  ]);

  const remote = await $`git ls-remote --heads origin`.env(ctx.env).cwd(ctx.repo).text();

  expect(heldExitCode).toBe(0);
  expect(heldOutput).not.toInclude('ran:');
  expect(remote).not.toInclude('refs/heads/hotfix');
});
