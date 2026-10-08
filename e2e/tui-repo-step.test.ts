import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { DaemonClient } from '../src/client/daemon-client';
import { buildStubSignedInGH } from '../src/test-utils/build-stub-signed-in-gh';
import { buildStubSignedOutGH } from '../src/test-utils/build-stub-signed-out-gh';
import { createGitFixture } from '../src/test-utils/create-git-fixture';
import { createStubBin } from '../src/test-utils/create-stub-bin';
import { KEYS } from '../src/test-utils/keys';
import { openRepoStep } from '../src/test-utils/open-repo-step';
import { registerTestCleanup } from '../src/test-utils/register-test-cleanup';
import { startTUIHarness } from '../src/test-utils/start-tui-harness';

function setupTest() {
  return startTUIHarness();
}

test('it spawns a session from a git repository at the commit the confirm screen shows, keeping choices across esc', async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  const dest = join(
    ctx.home,
    '.local',
    'share',
    'atc',
    'workspaces',
    `upstream-main-${fixture.sha.slice(0, 7)}`,
  );

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx);

  await ctx.waitFor('gh is not signed in on the daemon host');

  ctx.reset();
  ctx.write(`${fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor(`> ${dest}`);

  expect(ctx.read()).toInclude(`main → ${fixture.sha.slice(0, 12)}`);
  expect(ctx.read()).toInclude('dest    local:/');

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor(`> ${fixture.upstream}`);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: confirm');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor(`> ${dest}`);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('FAKE_CLAUDE_UP', 10_000);

  const daemon = await DaemonClient.open(join(ctx.home, 'atc-daemon.sock'));

  registerTestCleanup(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const listed = await daemon.sendRequest('session.list');

  expect(listed['sessions']).toMatchObject([
    { cwd: dest, workspace: { repoURL: fixture.upstream, sha: fixture.sha, ref: 'main' } },
  ]);

  expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe('hello\n');
}, 30_000);

test('it filters refs by name on the ref step', async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx);

  ctx.write(`${fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  ctx.write('b');

  await ctx.waitFor('> b');

  expect(ctx.read()).not.toInclude('main  default');
}, 20_000);

test('it refuses an abbreviated commit id on the ref step', async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx);

  ctx.write(`${fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  ctx.write(`${fixture.sha.slice(0, 7)}${KEYS.enter}`);

  await ctx.waitFor('full commit id required');

  expect(ctx.read()).not.toInclude('spawn: confirm');
}, 20_000);

test("it lists the gh account's repositories and an owner's on request, and leaves on esc", async () => {
  const ctx = setupTest();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedInGH());

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx);

  await ctx.waitFor('me/dots  dotfiles');

  ctx.reset();
  ctx.write(`acme/${KEYS.enter}`);

  await ctx.waitFor('acme/app  private');

  expect(ctx.read()).toInclude('spawn: GitHub repository · acme');

  expect(readFileSync(join(ctx.home, 'gh-argv'), 'utf8')).toMatch(
    /^repo list --limit .*\nconfig get git_protocol\nrepo list acme --limit .*\nconfig get git_protocol\n$/u,
  );

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('spawn: agent');
}, 20_000);

test('it shows a repository the daemon cannot read on the repository step', async () => {
  const ctx = setupTest();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx);

  ctx.reset();
  ctx.write(`${join(ctx.home, 'missing.git')}${KEYS.enter}`);

  await ctx.waitFor('clone_failed');

  expect(ctx.read()).toInclude('spawn: GitHub repository');
  expect(ctx.read()).not.toInclude('spawn: ref');
}, 20_000);

test('it opens github mode on a target that takes a workspace when the default cannot, and esc at the target step returns to the directory', async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  ctx.writeConfig({
    targets: {
      local: { provider: 'local-pty' },
      alt: { provider: 'local-pty', tag: 'alt' },
      far: { provider: 'nowhere' },
    },
    defaultTarget: 'far',
  });

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory');

  ctx.reset();
  ctx.write(KEYS.tab);

  await ctx.waitFor('spawn: target');

  expect(ctx.read()).toInclude('\u001B[7mlocal  local-pty');
  expect(ctx.read()).toInclude('\u001B[90mfar  nowhere · default · unavailable');

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('spawn: directory');

  ctx.reset();
  ctx.write(KEYS.tab);

  await ctx.waitFor('spawn: target');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: GitHub repository');

  ctx.reset();
  ctx.write(`${fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('target  local (local-pty)');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('FAKE_CLAUDE_UP', 10_000);
}, 30_000);

test('it opens github mode on the one target that takes a workspace without a target step, and esc returns to the agent', async () => {
  const ctx = setupTest();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  ctx.writeConfig({
    targets: { local: { provider: 'local-pty' }, far: { provider: 'nowhere' } },
    defaultTarget: 'far',
  });

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx);

  await ctx.waitFor('gh is not signed in on the daemon host');

  expect(ctx.read()).not.toInclude('spawn: target');

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('spawn: agent');
}, 15_000);

test("it builds each target's own default destination when the target changes", async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  const name = `upstream-main-${fixture.sha.slice(0, 7)}`;

  ctx.writeConfig({
    targets: { local: { provider: 'local-pty' }, alt: { provider: 'local-pty', tag: 'alt' } },
    defaultTarget: 'local',
    workspaces: { targets: { alt: join(ctx.home, 'alt-ws') } },
  });

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory');

  ctx.reset();
  ctx.write(KEYS.tab);

  await ctx.waitFor('spawn: target');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: GitHub repository');

  ctx.reset();
  ctx.write(`${fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor(`> ${join(ctx.home, '.local', 'share', 'atc', 'workspaces', name)}`);

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor(`> ${fixture.upstream}`);

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('spawn: target');

  ctx.reset();
  ctx.write(KEYS.down);

  await ctx.waitFor('\u001B[7malt  local-pty');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor(`> ${fixture.upstream}`);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor(`> ${join(ctx.home, 'alt-ws', name)}`);

  expect(ctx.read()).toInclude('target  alt (local-pty)');
}, 30_000);

test('it leaves a destination under a ~ root to a remote target and refuses a typed one that relies on ~', async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  // An imp target with a url and no token takes a workspace; nothing here
  // reaches impd, since no spawn is sent.
  ctx.writeConfig({
    targets: {
      local: { provider: 'local-pty' },
      box: { provider: 'imp', url: 'http://127.0.0.1:9' },
    },
    defaultTarget: 'local',
    workspaces: { targets: { box: '~/ws' } },
  });

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory');

  ctx.reset();
  ctx.write(KEYS.tab);

  await ctx.waitFor('spawn: target');

  ctx.reset();
  ctx.write(KEYS.down);

  await ctx.waitFor('\u001B[7mbox  imp');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: GitHub repository');

  ctx.reset();
  ctx.write(`${fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('dest    box:~/ws/upstream-main-');

  expect(ctx.read()).toInclude('picked on the target');

  ctx.reset();
  ctx.write(`~/ws/app${KEYS.enter}`);

  await ctx.waitFor('~ is not expanded there');

  expect(ctx.read()).not.toInclude('spawn: name');
}, 30_000);

test('it offers the other URL form after a failed probe and checks that form on request', async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());
  mkdirSync(join(ctx.home, 'mirror', 'acme'), { recursive: true });

  await $`git clone --quiet --bare --template= ${fixture.upstream} ${join(ctx.home, 'mirror', 'acme', 'app.git')}`
    .env(fixture.env)
    .quiet();

  // The daemon reads the home's git config: the ssh form of acme/app reads
  // the mirror, and the https form reads a path that does not exist, so no
  // request reaches GitHub.
  writeFileSync(
    join(ctx.home, '.gitconfig'),
    `[url "file://${join(ctx.home, 'mirror')}/"]\n\tinsteadOf = git@github.com:\n[url "file://${join(ctx.home, 'nowhere')}/"]\n\tinsteadOf = https://github.com/\n`,
  );

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx);

  ctx.reset();
  ctx.write(`acme/app${KEYS.enter}`);

  await ctx.waitFor('try git@github.com:acme/app.git instead');

  expect(ctx.read()).toInclude('clone_failed');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('source  git@github.com:acme/app.git');
}, 30_000);

test('it drops a typed destination when the repository changes', async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  const other = join(ctx.home, 'other.git');

  await $`git clone --quiet --bare --template= ${fixture.upstream} ${other}`
    .env(fixture.env)
    .quiet();

  const custom = join(ctx.home, 'custom-dest');

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx);

  ctx.reset();
  ctx.write(`${fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: confirm');

  ctx.reset();
  ctx.write(KEYS.ctrlU);

  await ctx.waitFor('> \u001B[93m█');

  ctx.write(`${custom}${KEYS.enter}`);

  await ctx.waitFor('spawn: name');

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor(`> ${custom}`);

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor(`> ${fixture.upstream}`);

  ctx.reset();
  ctx.write(KEYS.ctrlU);

  await ctx.waitFor('> \u001B[93m█');

  ctx.reset();
  ctx.write(`${other}${KEYS.enter}`);

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: confirm');

  expect(ctx.read()).toInclude(`other-main-${fixture.sha.slice(0, 7)}`);
  expect(ctx.read()).not.toInclude(custom);
}, 30_000);
