import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import {
  KEYS,
  buildStubSignedInGH,
  buildStubSignedOutGH,
  createGitFixture,
  createStubBin,
  openAgentStep,
  registerTestCleanup,
  startTUIHarness,
} from '@atc/test-utils';
import { $ } from 'bun';

function setupTest() {
  return startTUIHarness();
}

test('it keeps paths and slash filters in the one list', async () => {
  const ctx = setupTest();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openAgentStep(ctx);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: workspace');

  ctx.reset();
  ctx.write('~/');

  await ctx.waitFor('> ~/');

  ctx.reset();
  ctx.write(KEYS.ctrlU);

  await ctx.waitFor('> \u001B[93m█');

  ctx.reset();
  ctx.write('atc/src');

  await ctx.waitFor('> atc/src');

  expect(ctx.read()).toInclude('spawn: workspace');
});

test('it moves tab to the next source with rows and wraps to the directories', async () => {
  const ctx = setupTest();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openAgentStep(ctx);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: workspace');

  expect(ctx.read()).toInclude(' · tab next source');

  ctx.reset();
  ctx.write(KEYS.tab);

  await ctx.waitFor('\u001B[7mgithub:');

  ctx.reset();
  ctx.write(KEYS.tab);

  await ctx.waitFor('\u001B[7m~  ');
});

test('it keeps a pasted git URL in the one list as typed text', async () => {
  const ctx = setupTest();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openAgentStep(ctx);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: workspace');

  ctx.reset();
  ctx.write('https://github.com/acme/app.git');

  await ctx.waitFor('> https://github.com/acme/app.git');

  expect(ctx.read()).toInclude('spawn: workspace');
});

test('it drives a source from its candidates to the confirm screen', async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedInGH());
  mkdirSync(join(ctx.home, 'mirror', 'acme'), { recursive: true });

  await $`git clone --quiet --bare --template= ${fixture.upstream} ${join(ctx.home, 'mirror', 'acme', 'app.git')}`
    .env(fixture.env)
    .quiet();

  // The daemon reads the home's git config, which sends the https form of
  // acme/app to the mirror, so no request reaches GitHub.
  writeFileSync(
    join(ctx.home, '.gitconfig'),
    `[url "file://${join(ctx.home, 'mirror')}/"]\n\tinsteadOf = https://github.com/\n`,
  );

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openAgentStep(ctx);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: workspace');

  ctx.reset();
  ctx.write(KEYS.tab);

  await ctx.waitFor('\u001B[7mgithub:me/dots  dotfiles');

  ctx.reset();
  ctx.write(`acme/${KEYS.enter}`);

  await ctx.waitFor('\u001B[7mgithub:acme/app  private');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: confirm');

  expect(ctx.read()).toInclude('source  https://github.com/acme/app.git');
});

test('it spawns the repository a source reads typed text as, through to its workspace', async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openAgentStep(ctx);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: workspace');

  ctx.reset();
  ctx.write(`file://${fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`, 10_000);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: confirm');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  ctx.write(`picked${KEYS.enter}`);

  await ctx.waitFor('spawn: initial prompt');

  ctx.write(KEYS.enter);

  await ctx.waitFor('FAKE_CLAUDE_UP', 10_000);

  const daemon = await openDaemonClient(ctx.paths.daemonSocketPath);

  registerTestCleanup(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const listed = await daemon.sendRequest('session.list');

  expect(listed['sessions']).toMatchObject([
    {
      name: 'picked',
      cwd: join(
        ctx.home,
        '.local',
        'share',
        'atc',
        'workspaces',
        `upstream-main-${fixture.sha.slice(0, 7)}`,
      ),
      workspace: { repoURL: `file://${fixture.upstream}`, sha: fixture.sha, ref: 'main' },
    },
  ]);
});

test('it lists the scope a source reads from typed text once, with no target step before it', async () => {
  const ctx = setupTest();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedInGH());

  ctx.writeConfig({
    targets: { local: { provider: 'local-pty' }, alt: { provider: 'local-pty', tag: 'alt' } },
    defaultTarget: 'local',
  });

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openAgentStep(ctx);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: workspace');

  ctx.reset();
  ctx.write('acme/');

  await ctx.waitFor('> acme/');

  ctx.write(KEYS.enter);

  await ctx.waitFor('github:acme/app  private');

  expect(ctx.read()).toInclude('spawn: workspace · github: acme');
  expect(ctx.read()).not.toInclude('spawn: target');

  const lists = readFileSync(join(ctx.home, 'gh-argv'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('repo list acme '));

  expect(lists).toHaveLength(1);
});

test('it refuses a spawn when the config offers no sources', async () => {
  const ctx = setupTest();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  ctx.writeConfig({ workspaces: { sources: [] } });
  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openAgentStep(ctx);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('the daemon offers no sources');

  expect(ctx.read()).not.toInclude('spawn: workspace');
});

test('it lists an owner typed in the list through the source that reads it', async () => {
  const ctx = setupTest();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedInGH());

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openAgentStep(ctx);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: workspace');

  ctx.reset();
  ctx.write(`acme/${KEYS.enter}`);

  await ctx.waitFor('spawn: workspace · github: acme');
  await ctx.waitFor('github:acme/app  private');

  const lists = readFileSync(join(ctx.home, 'gh-argv'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('repo list acme '));

  expect(lists).toHaveLength(1);
});

test('it probes a repository typed in the list at the URL its source reads it as', async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());
  mkdirSync(join(ctx.home, 'mirror', 'acme'), { recursive: true });

  await $`git clone --quiet --bare --template= ${fixture.upstream} ${join(ctx.home, 'mirror', 'acme', 'app.git')}`
    .env(fixture.env)
    .quiet();

  // The daemon reads the home's git config, which sends the https form of
  // acme/app to the mirror, so no request reaches GitHub.
  writeFileSync(
    join(ctx.home, '.gitconfig'),
    `[url "file://${join(ctx.home, 'mirror')}/"]\n\tinsteadOf = https://github.com/\n`,
  );

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openAgentStep(ctx);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: workspace');

  ctx.reset();
  ctx.write(`acme/app${KEYS.enter}`);

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('source  https://github.com/acme/app.git');
});

test('it offers only the sources the config gives, and returns esc from the ref step to the list', async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  ctx.writeConfig({ workspaces: { sources: ['git', 'dirs'] } });
  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openAgentStep(ctx);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: workspace');

  ctx.reset();
  ctx.write(`file://${fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`);

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor(ctx.formatInput(`file://${fixture.upstream}`));

  expect(ctx.read()).toInclude('spawn: workspace');
  expect(ctx.read()).not.toInclude('github');
});
