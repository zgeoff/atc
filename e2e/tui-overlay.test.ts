import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import {
  KEYS,
  openAgentStep,
  registerTestCleanup,
  spawnClaudeSession,
  spawnDaemonSession,
  spawnNamedSession,
  startTUIHarness,
  waitFor,
} from '@atc/test-utils';
import { startTUIDaemon } from '../packages/app/src/test-utils/start-tui-daemon';

// The client attaches to a daemon in the test's process, so a boot loads
// one process instead of two.
async function setupTest() {
  const tui = startTUIHarness();

  await startTUIDaemon(tui);

  return tui;
}

test('it narrows the overlay to sessions matching the slash filter', async () => {
  const ctx = await setupTest();

  // The sessions report no prompt, so neither names itself in the status
  // bar as the session that needs you.
  writeFileSync(join(ctx.home, 'fake-claude-events.jsonl'), '');

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnDaemonSession(ctx, 'alpha');
  await spawnDaemonSession(ctx, 'bravo');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('bravo');

  ctx.write('/');

  await ctx.waitFor('/ \u001B[93m█');

  ctx.reset();
  ctx.write('brav');

  // A session's state change can repaint the overlay before the typed text
  // reaches it, so only the latest frame counts.
  await waitFor(() => {
    const frame = ctx.read().split('┌ sessions ').at(-1);

    expect(frame).toInclude('/ brav');
    expect(frame).toInclude('bravo');
    expect(frame).not.toInclude('alpha');
  });
});

test('it opens the overlay with a configured leader key', async () => {
  const ctx = await setupTest();

  ctx.writeConfig({ leader: 'ctrl-]' });
  ctx.boot();

  await ctx.waitFor('atc — control tower');

  // The home screen's status bar ends with the leader's label; an attached
  // session draws no status bar.
  await ctx.waitFor('▏^] ');

  await spawnDaemonSession(ctx, 'leadertest');

  ctx.reset();
  ctx.write(KEYS.ctrlRightBracket);

  await ctx.waitFor('┌ sessions ');
  await ctx.waitFor('leadertest');
});

test('it pins a session from the overlay and marks its row', async () => {
  const ctx = await setupTest();

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
});

test('it clusters overlay rows under repository headers when grouping is toggled on', async () => {
  const ctx = await setupTest();

  const otherProject = join(ctx.home, 'otherproj');

  mkdirSync(otherProject, { recursive: true });

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'first');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: first');
  await ctx.waitFor('┌ sessions ');

  await openAgentStep(ctx);

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
});

test('it lists a sub-session indented under its parent', async () => {
  const ctx = await setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  const daemon = await openDaemonClient(join(ctx.home, 'atc-daemon.sock'));

  registerTestCleanup(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const parentID = await spawnNamedSession(
    (method, params) => daemon.sendRequest(method, params),
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
});

test('it lists a detached sub-session as top-level', async () => {
  const ctx = await setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  const daemon = await openDaemonClient(join(ctx.home, 'atc-daemon.sock'));

  registerTestCleanup(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const parentID = await spawnNamedSession(
    (method, params) => daemon.sendRequest(method, params),
    'wrangler',
    ctx.home,
  );

  const workerID = await spawnNamedSession(
    (method, params) => daemon.sendRequest(method, { ...params, parent: parentID }),
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
});

test('it preselects the focused session when the overlay opens', async () => {
  const ctx = await setupTest();

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
});

test('it opens the key reference from the overlay and returns on esc', async () => {
  const ctx = await setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnDaemonSession(ctx, 'helptest');

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
