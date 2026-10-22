import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import {
  KEYS,
  createGitFixture,
  openAgentStep,
  registerTestCleanup,
  spawnClaudeSession,
  startTUIHarness,
} from '@atc/test-utils';
import { $ } from 'bun';

function setupTest() {
  return startTUIHarness();
}

test('it leaves an agent with no installed binary out of the picker', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.reset();
  ctx.write('n');

  // The agent step opens before the daemon lists the agents, so the menu is
  // read once an agent it lists is drawn.
  await ctx.waitFor('Grok');

  const menu = ctx.read();

  expect(menu).toInclude('Claude');
  expect(menu).toInclude('Grok');
  expect(menu).not.toInclude('Codex');
}, 15_000);

test('it shows a refused spawn in the picker and keeps the entered prompt', async () => {
  const ctx = setupTest();

  // Claude is the only agent installed, and its plugin folder is missing, so
  // the daemon lists it as able to start and refuses the spawn itself.
  ctx.writeConfig({
    agents: {
      claude: { pluginDirs: [join(ctx.home, 'missing-plugins')] },
      grok: { bin: join(ctx.home, 'missing-grok') },
    },
  });

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

  await ctx.waitFor('bad_args: plugin folder');

  const screen = ctx.read();

  expect(screen).toInclude('spawn: initial prompt');
  expect(screen).toInclude('> hello');
  expect(screen).not.toInclude('FAKE_CLAUDE_UP');
}, 15_000);

test('it spawns on the target chosen in the target step, keeping the choice across esc', async () => {
  const ctx = setupTest();

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

  await openAgentStep(ctx);

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

  const mark = ctx.countClientLogLines();

  ctx.write('x');

  await ctx.waitForClientLog('ignored text on the target step', mark);

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

  const daemon = await openDaemonClient(join(ctx.home, 'atc-daemon.sock'));

  registerTestCleanup(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const listed = await daemon.sendRequest('session.list');

  expect(listed['sessions']).toMatchObject([
    { name: 'elsewhere', cwd: ctx.home, locator: { targetID: 'alt' } },
  ]);
}, 20_000);

test('it keeps the target step open on a target whose provider the daemon lacks', async () => {
  const ctx = setupTest();

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

  await openAgentStep(ctx);

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
  const ctx = setupTest();

  const fixture = await createGitFixture();

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

  await openAgentStep(ctx);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory');

  ctx.write(fixture.work);

  await ctx.waitFor(ctx.formatInput(fixture.work));

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

test('it starts claude with the settings file atc generates', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'withsettings');

  expect(ctx.read()).toInclude(
    `--settings ${join(ctx.home, '.local', 'state', 'atc', 'hook-settings-claude.json')} `,
  );
});
