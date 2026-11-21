import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openAgentStep } from '@atc/app/test-utils/open-agent-step';
import { spawnClaudeSession } from '@atc/app/test-utils/spawn-claude-session';
import { spawnDaemonSession } from '@atc/app/test-utils/spawn-daemon-session';
import { startTUIDaemon } from '@atc/app/test-utils/start-tui-daemon';
import { startTUIHarness } from '@atc/app/test-utils/start-tui-harness';
import { KEYS } from '@atc/core/test-utils/keys';
import { createDaemonClient } from '@atc/protocol/client';
import { spawnNamedSession } from '@atc/protocol/test-utils/spawn-named-session';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';
import { registerTestCleanup, waitFor } from '@zgeoff/testing';

// The client attaches to a daemon in the test's process, so a boot loads
// one process instead of two.
async function setupTest() {
  const tui = startTUIHarness({ createStateDB: createMigratedStateDB });

  await startTUIDaemon(tui);

  return tui;
}

test('it narrows the overlay to sessions matching the slash filter', async () => {
  const ctx = await setupTest();

  // The sessions report no prompt, so neither names itself in the status bar as the session that needs you.
  writeFileSync(join(ctx.home, 'fake-claude-events.jsonl'), '');

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnDaemonSession(ctx, 'alpha');
  await spawnDaemonSession(ctx, 'bravo');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('bravo');

  ctx.write('/');

  await ctx.waitFor('/ █');

  ctx.reset();
  ctx.write('brav');

  // A session's state change can repaint the overlay before the typed text
  // reaches it, so only the latest frame counts.
  await waitFor(() => {
    const frame = ctx.read().split('╭─ ').at(-1);

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

  // An attached session draws no status bar, so this label only appears on the home screen.
  await ctx.waitFor('▏^] ');

  await spawnDaemonSession(ctx, 'leadertest');

  ctx.reset();
  ctx.write(KEYS.ctrlRightBracket);

  await ctx.waitFor('leadertest');

  expect(ctx.read().split('╭─ ').at(-1)).toInclude('leadertest');
});

test('it pins a session from the list and groups it under pinned', async () => {
  const ctx = await setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'pinme');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('◆ 1 need you');
  await ctx.waitFor('╭─ ');

  ctx.write('g');

  await ctx.waitFor('by repo');

  ctx.write('p');

  await waitFor(() => {
    expect(ctx.readScreen()).toMatch(/^\s*│ pinned {2}1/mu);
  });
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

  await ctx.waitFor('◆ 1 need you');
  await ctx.waitFor('╭─ ');

  await openAgentStep(ctx);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: workspace');

  ctx.write(otherProject);

  await ctx.waitFor(ctx.formatInput(otherProject));

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  // The first spawn's prompt step is still in the buffer and would satisfy the next wait.
  ctx.reset();
  ctx.write(`second${KEYS.enter}`);

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('FAKE_CLAUDE_UP');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('second');

  expect(ctx.readScreen()).not.toMatch(/^\s*│ otherproj {2}1/mu);

  ctx.write('g');

  await ctx.waitFor('by repo');

  expect(ctx.readScreen()).toMatch(/^\s*│ otherproj {2}1/mu);
});

test('it lists a sub-session indented under its parent', async () => {
  const ctx = await setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  const daemon = createDaemonClient(ctx.paths.daemonSocketPath);

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

  const daemon = createDaemonClient(ctx.paths.daemonSocketPath);

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
    const frame = ctx.read().split('╭─ ').at(-1);

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

  await ctx.waitFor('◆ 1 need you');
  await ctx.waitFor('╭─ ');

  await spawnClaudeSession(ctx, 'second');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('second');

  expect(ctx.readScreen()).toMatch(/▌.*second/u);
});

test('it opens the key reference from the overlay and returns on esc', async () => {
  const ctx = await setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnDaemonSession(ctx, 'helptest');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('needs you: ');
  await ctx.waitFor('╭─ ');

  ctx.write('?');

  await ctx.waitFor('┌ keys ');

  ctx.write(KEYS.esc);

  await ctx.waitForGone('┌ keys ');
  await ctx.waitFor('╭─ ');

  expect(ctx.readScreen()).toInclude('helptest');
});
