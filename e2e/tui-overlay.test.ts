import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../src/client/daemon-client';
import { KEYS } from '../src/test-utils/keys';
import { spawnClaudeSession } from '../src/test-utils/spawn-claude-session';
import { spawnNamedSession } from '../src/test-utils/spawn-named-session';
import { startTUIHarness } from '../src/test-utils/start-tui-harness';

function setupTest() {
  return startTUIHarness();
}

test('it narrows the overlay to sessions matching the slash filter', async () => {
  await using ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'alpha');

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: alpha');

  // Attaching alpha stops it being the urgent session in the status bar;
  // the attach jiggle repaints the fake.
  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('FAKE_CLAUDE_UP');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('sessions');

  await spawnClaudeSession(ctx, 'bravo');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('bravo');

  ctx.write('/');

  await ctx.waitFor('type to filter');

  ctx.reset();
  ctx.write('brav');

  await ctx.waitFor('/ brav');
  await ctx.waitFor('bravo');

  expect(ctx.read()).not.toInclude('alpha        ');
});

test('it opens the overlay with a configured leader key', async () => {
  await using ctx = setupTest();

  ctx.writeConfig({ leader: 'ctrl-]' });
  ctx.boot();

  await ctx.waitFor('atc — control tower');

  expect(ctx.read()).toInclude('^]');

  await spawnClaudeSession(ctx, 'leadertest');

  ctx.reset();
  ctx.write(KEYS.ctrlRightBracket);

  await ctx.waitFor('leadertest');
  await ctx.waitFor('sessions');
});

test('it pins a session from the overlay and marks its row', async () => {
  await using ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'pinme');

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: pinme');

  ctx.reset();
  ctx.write('p');

  await ctx.waitFor('⋆');
}, 15_000);

test('it clusters overlay rows under repository headers when grouping is toggled on', async () => {
  await using ctx = setupTest();

  const otherProject = join(ctx.home, 'otherproj');

  mkdirSync(otherProject, { recursive: true });

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'first');

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: first');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory');

  ctx.write(otherProject);

  await ctx.waitFor(`> ${otherProject}`);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  // The first spawn's prompt step is still in the buffer.
  ctx.reset();
  ctx.write(`second${KEYS.enter}`);

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('FAKE_CLAUDE_UP');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('second');

  expect(ctx.read()).not.toInclude('▸');

  ctx.reset();
  ctx.write('g');

  await ctx.waitFor('▸');
  await ctx.waitFor('otherproj');
}, 15_000);

test('it lists a sub-session indented under its parent', async () => {
  await using ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  const daemon = await DaemonClient.open(join(ctx.home, 'atc-daemon.sock'));

  onTestFinished(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const parentID = await spawnNamedSession(
    (m, p) => daemon.sendRequest(m, p),
    'wrangler',
    ctx.home,
  );

  await daemon.sendRequest('session.spawn', {
    cwd: ctx.home,
    name: 'worker',
    parent: parentID,
    cols: 80,
    rows: 24,
  });

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('↳ worker');

  expect(ctx.read()).toMatch(/wrangler[\s\S]*↳ worker/u);
}, 15_000);

test('it preselects the focused session when the overlay opens', async () => {
  await using ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'first');

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: first');

  await spawnClaudeSession(ctx, 'second');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('second');

  expect(ctx.read()).toInclude('\u001B[7msecond');
}, 15_000);

test('it opens the key reference from the overlay and returns on esc', async () => {
  await using ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'helptest');

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: helptest');

  ctx.write('?');

  await ctx.waitFor('adopt an external session');

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('helptest');
});
