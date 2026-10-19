import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import {
  KEYS,
  registerTestCleanup,
  spawnClaudeSession,
  spawnNamedSession,
  startTUIHarness,
  waitFor,
} from '@atc/test-utils';

function setupTest() {
  return startTUIHarness();
}

test('it narrows the overlay to sessions matching the slash filter', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'alpha');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: alpha');
  await ctx.waitFor('┌ sessions ');

  // Attaching alpha stops it being the urgent session in the status bar;
  // the attach jiggle repaints the fake.
  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('FAKE_CLAUDE_UP');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('┌ sessions ');

  await spawnClaudeSession(ctx, 'bravo');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('bravo');

  ctx.write('/');

  await ctx.waitFor('/ \u001B[93m█');

  ctx.reset();
  ctx.write('brav');

  await ctx.waitFor('/ brav');
  await ctx.waitFor('bravo');

  expect(ctx.read()).not.toInclude('alpha');
});

test('it opens the overlay with a configured leader key', async () => {
  const ctx = setupTest();

  ctx.writeConfig({ leader: 'ctrl-]' });
  ctx.boot();

  await ctx.waitFor('atc — control tower');

  // The home screen's status bar ends with the leader's label; an attached
  // session draws no status bar.
  await ctx.waitFor('▏^] ');

  await spawnClaudeSession(ctx, 'leadertest');

  ctx.reset();
  ctx.write(KEYS.ctrlRightBracket);

  await ctx.waitFor('┌ sessions ');
  await ctx.waitFor('leadertest');
});

test('it pins a session from the overlay and marks its row', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'pinme');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: pinme');
  await ctx.waitFor('┌ sessions ');

  ctx.reset();
  ctx.write('p');

  await ctx.waitFor('⋆');
}, 15_000);

test('it clusters overlay rows under repository headers when grouping is toggled on', async () => {
  const ctx = setupTest();
  const otherProject = join(ctx.home, 'otherproj');

  mkdirSync(otherProject, { recursive: true });

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'first');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: first');
  await ctx.waitFor('┌ sessions ');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory');

  ctx.write(otherProject);

  await ctx.waitFor(ctx.formatInput(otherProject));

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
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  const daemon = await openDaemonClient(join(ctx.home, 'atc-daemon.sock'));

  registerTestCleanup(() => {
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

test('it lists a detached sub-session as top-level', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  const daemon = await openDaemonClient(join(ctx.home, 'atc-daemon.sock'));

  registerTestCleanup(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const parentID = await spawnNamedSession(
    (m, p) => daemon.sendRequest(m, p),
    'wrangler',
    ctx.home,
  );

  const workerID = await spawnNamedSession(
    (m, p) => daemon.sendRequest(m, { ...p, parent: parentID }),
    'worker',
    ctx.home,
  );

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('↳ worker');

  ctx.reset();

  await daemon.sendRequest('session.update', { session: workerID, parent: null });

  // Another session's state can repaint the overlay before the detach
  // does, so only the latest frame counts.
  await waitFor(() => {
    const frame = ctx.read().split('┌ sessions ').at(-1);

    expect(frame).toInclude('worker');
    expect(frame).not.toInclude('↳');
  });
}, 15_000);

test('it preselects the focused session when the overlay opens', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'first');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: first');
  await ctx.waitFor('┌ sessions ');

  await spawnClaudeSession(ctx, 'second');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('second');

  expect(ctx.read()).toInclude('\u001B[7msecond');
}, 15_000);

test('it opens the key reference from the overlay and returns on esc', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'helptest');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: helptest');
  await ctx.waitFor('┌ sessions ');

  ctx.write('?');

  await ctx.waitFor('┌ keys ');

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('helptest');
});
