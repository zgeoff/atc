import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { buildStubSignedOutGH } from '../src/test-utils/build-stub-signed-out-gh';
import { createGitFixture } from '../src/test-utils/create-git-fixture';
import { createStubBin } from '../src/test-utils/create-stub-bin';
import { KEYS } from '../src/test-utils/keys';
import { openRepoStep } from '../src/test-utils/open-repo-step';
import { startTUIHarness } from '../src/test-utils/start-tui-harness';

/**
 * The client's harness with a signed-out `gh` on the PATH of the client and
 * its daemons, and a git upstream for the spawn to clone.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tui = stack.use(startTUIHarness());

  // The repository step lists the account's repositories through gh; a
  // signed-out one keeps the step from reaching the host's own gh.
  createStubBin(join(tui.home, 'bin'), 'gh', buildStubSignedOutGH());

  const created = await createGitFixture();

  const fixture = stack.use(created);
  const owned = stack.move();

  return { ...tui, fixture, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it returns a spawn into an existing destination to the confirm screen with a suffix offered', async () => {
  await using ctx = await setupTest();

  writeFileSync(join(ctx.fixture.work, 'notes.md'), 'from the upstream\n');

  await $`git add notes.md`.env(ctx.fixture.env).cwd(ctx.fixture.work).quiet();

  await $`git commit --quiet --no-gpg-sign -m notes`
    .env(ctx.fixture.env)
    .cwd(ctx.fixture.work)
    .quiet();

  await $`git push --quiet origin main`.env(ctx.fixture.env).cwd(ctx.fixture.work).quiet();

  const sha = await $`git rev-parse HEAD`
    .env(ctx.fixture.env)
    .cwd(ctx.fixture.work)
    .text()
    .then((text) => text.trim());

  const dest = join(
    ctx.home,
    '.local',
    'share',
    'atc',
    'workspaces',
    `upstream-main-${sha.slice(0, 7)}`,
  );

  mkdirSync(dest, { recursive: true });

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx);

  ctx.write(`${ctx.fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor('spawn: ref');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: confirm');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('workspace_exists', 10_000);

  expect(ctx.read()).toInclude(`> ${dest}-2`);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('FAKE_CLAUDE_UP', 10_000);

  expect(readFileSync(join(`${dest}-2`, 'notes.md'), 'utf8')).toBe('from the upstream\n');
}, 30_000);

test('it returns a spawn whose clone fails to the repository step', async () => {
  await using ctx = await setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx);

  ctx.write(`${ctx.fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor('spawn: ref');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: confirm');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: initial prompt');

  rmSync(ctx.fixture.upstream, { recursive: true, force: true });

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('clone_failed', 10_000);

  expect(ctx.read()).toInclude('spawn: GitHub repository');
}, 30_000);

test('it returns a spawn whose commit left the upstream to the ref step with the refs re-read', async () => {
  await using ctx = await setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx);

  ctx.write(`${ctx.fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor('spawn: ref');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: confirm');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: initial prompt');

  // Main moves to an unrelated commit and the old one is pruned, so the
  // pinned commit is no longer in the upstream.
  await $`git checkout --quiet --orphan rewritten`
    .env(ctx.fixture.env)
    .cwd(ctx.fixture.work)
    .quiet();

  await $`git commit --quiet --no-gpg-sign -m rewritten`
    .env(ctx.fixture.env)
    .cwd(ctx.fixture.work)
    .quiet();

  await $`git push --quiet --force origin rewritten:main`
    .env(ctx.fixture.env)
    .cwd(ctx.fixture.work)
    .quiet();

  await $`git reflog expire --expire=now --all`
    .env(ctx.fixture.env)
    .cwd(ctx.fixture.upstream)
    .quiet();

  await $`git gc --quiet --prune=now`.env(ctx.fixture.env).cwd(ctx.fixture.upstream).quiet();

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('refs re-read', 10_000);

  const rewritten = await $`git rev-parse HEAD`
    .env(ctx.fixture.env)
    .cwd(ctx.fixture.work)
    .text()
    .then((text) => text.trim());

  expect(ctx.read()).toInclude('ref_not_found');
  expect(ctx.read()).toInclude('spawn: ref');
  expect(ctx.read()).toInclude(`main  default · ${rewritten.slice(0, 7)}`);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor(`main → ${rewritten.slice(0, 12)}`);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('FAKE_CLAUDE_UP', 10_000);
}, 40_000);
