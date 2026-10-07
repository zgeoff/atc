import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { DaemonClient } from '../src/client/daemon-client';
import { createGitFixture } from '../src/test-utils/create-git-fixture';
import { KEYS } from '../src/test-utils/keys';
import { startTUIHarness } from '../src/test-utils/start-tui-harness';

function setupTest() {
  return startTUIHarness();
}

test('it leaves an agent with no installed binary out of the picker', async () => {
  await using ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.reset();
  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  const menu = ctx.read();

  expect(menu).toInclude('Claude');
  expect(menu).toInclude('Grok');
  expect(menu).not.toInclude('Codex');

  ctx.write(KEYS.down);

  await ctx.waitFor('\u001B[7mGrok');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory');
}, 15_000);

test('it shows a refused spawn in the picker and keeps the entered prompt', async () => {
  await using ctx = setupTest();

  // A config that is not JSON drops the configured binaries, so the default
  // claude resolves on PATH to the fake one, the only agent installed, and
  // the daemon's target check is what refuses the spawn.
  writeFileSync(ctx.configPath, '{ "targets": ');
  mkdirSync(join(ctx.home, 'bin'));
  symlinkSync(join(ctx.home, 'fake-claude'), join(ctx.home, 'bin', 'claude'));

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  // One installed agent is no choice, so the flow passes the agent step on
  // its own once the daemon answers; a key typed there would land on the
  // directory step instead.
  ctx.write('n');

  await ctx.waitFor('spawn: directory');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  ctx.reset();
  ctx.write(`broken${KEYS.enter}`);

  await ctx.waitFor('spawn: initial prompt');

  ctx.write('hello');

  await ctx.waitFor('> hello');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('target_config_invalid: config file');

  const screen = ctx.read();

  expect(screen).toInclude('spawn: initial prompt');
  expect(screen).toInclude('> hello');
  expect(screen).not.toInclude('FAKE_CLAUDE_UP');
}, 15_000);

test('it spawns on the target chosen in the target step, keeping the choice across esc', async () => {
  await using ctx = setupTest();

  ctx.writeConfig({
    targets: {
      local: { provider: 'local-pty' },
      alt: { provider: 'local-pty', tag: 'alt' },
      far: { provider: 'nowhere' },
    },
    defaultTarget: 'local',
  });

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: target');

  const menu = ctx.read();

  expect(menu).toInclude('\u001B[7mlocal  local-pty · default');
  expect(menu).toInclude('\u001B[90mfar  nowhere · unavailable');

  ctx.reset();
  ctx.write(KEYS.down);

  await ctx.waitFor('\u001B[7malt  local-pty');

  ctx.write('x');

  await ctx.waitForClientLog('ignored text on the target step');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  expect(ctx.read()).not.toInclude('> x');

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('\u001B[7malt  local-pty');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  ctx.write(`elsewhere${KEYS.enter}`);

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('FAKE_CLAUDE_UP');

  const daemon = await DaemonClient.open(join(ctx.home, 'atc-daemon.sock'));

  onTestFinished(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const listed = await daemon.sendRequest('session.list');

  expect(listed['sessions']).toMatchObject([
    { name: 'elsewhere', cwd: ctx.home, locator: { targetID: 'alt' } },
  ]);
}, 20_000);

test('it keeps the target step open on a target the directory cannot run on', async () => {
  await using ctx = setupTest();

  ctx.writeConfig({
    targets: {
      local: { provider: 'local-pty' },
      alt: { provider: 'local-pty', tag: 'alt' },
      far: { provider: 'nowhere' },
    },
    defaultTarget: 'local',
  });

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: target');

  ctx.reset();
  ctx.write(KEYS.down);

  await ctx.waitFor('\u001B[7malt  local-pty');

  ctx.reset();
  ctx.write(KEYS.down);

  await ctx.waitFor('\u001B[7mfar  nowhere');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor("target 'far' is unavailable on this daemon");

  expect(ctx.read()).not.toInclude('spawn: name');

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('spawn: directory');
}, 15_000);

test('it sends a dirty local directory to a target off the daemon machine as a path workspace past its uncommitted file', async () => {
  await using ctx = setupTest();
  await using fixture = await createGitFixture();

  writeFileSync(join(fixture.work, 'scratch.txt'), 'uncommitted\n');

  // An imp target with a url and no token has a provider that can take a
  // workspace. The path source, which has no origin, is refused before the
  // daemon calls impd.
  await $`git remote remove origin`.env(fixture.env).cwd(fixture.work).quiet();

  ctx.writeConfig({
    targets: {
      local: { provider: 'local-pty' },
      box: { provider: 'imp', url: 'http://127.0.0.1:9' },
    },
    defaultTarget: 'local',
  });

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory');

  ctx.write(fixture.work);

  await ctx.waitFor(`> ${fixture.work}`);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: target');

  ctx.reset();
  ctx.write(KEYS.down);

  await ctx.waitFor('\u001B[7mbox  imp');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  ctx.write(KEYS.enter);

  // Without the path workspace the spawn would reach impd. The
  // uncommitted file stays behind, so resolution goes on to the missing
  // origin.
  await ctx.waitFor('no_origin', 10_000);

  expect(ctx.read()).not.toInclude('workspace_dirty');
  expect(ctx.read()).not.toInclude('FAKE_CLAUDE_UP');
}, 20_000);
