import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnClaudeSession } from '@atc/app/test-utils/spawn-claude-session';
import { startTUIHarness } from '@atc/app/test-utils/start-tui-harness';
import { KEYS } from '@atc/core/test-utils/keys';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';
import { waitFor } from '@zgeoff/testing';

function setupTest() {
  return startTUIHarness({ createStateDB: createMigratedStateDB });
}

test('it clears the need state when attaching a needy session', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'needytest');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('◆ 1 need you');
  await ctx.waitFor('┌ sessions ');

  ctx.write(KEYS.enter);

  await waitFor(
    () => {
      expect(readFileSync(ctx.paths.statusFile, 'utf8')).toInclude('"needs_you":0');
    },
    { timeoutMs: 3000 },
  );
});

test('it attaches and acks the session that needs you on tab', async () => {
  const ctx = setupTest();
  const statusPath = ctx.paths.statusFile;

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'needy');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('◆ 1 need you');
  await ctx.waitFor('┌ sessions ');

  // The attach jiggle repaints the fake.
  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('FAKE_CLAUDE_UP');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('┌ sessions ');

  await spawnClaudeSession(ctx, 'urgent');

  await waitFor(() => {
    expect(readFileSync(statusPath, 'utf8')).toInclude('"needs_you":1');
  });

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  // The daemon writes status.json before the client hears of the change, and a Tab the client
  // reads first finds nothing to jump to.
  await ctx.waitFor('┌ sessions ');
  await ctx.waitFor('◆ 1 need you');

  ctx.reset();
  ctx.write(KEYS.tab);

  // The attach jiggle repaints the fake, whose marker only reaches the
  // screen while attached, and only attaching urgent acks the one need left.
  await ctx.waitFor('FAKE_CLAUDE_UP');

  await waitFor(() => {
    expect(readFileSync(statusPath, 'utf8')).toInclude('"needs_you":0');
  });
}, 15_000);

test('it tab-jumps to a finished session when none need you', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, 'fake-claude-events.jsonl'),
    `${JSON.stringify({ hook_event_name: 'Stop', session_id: 'fake-1' })}\n`,
  );

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'finished');

  await waitFor(() => {
    expect(readFileSync(ctx.paths.statusFile, 'utf8')).toInclude('"done":1');
  });

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  // The daemon writes status.json before the client hears of the change, and a Tab the client
  // reads first finds nothing to jump to.
  await ctx.waitFor('┌ sessions ');
  await ctx.waitFor('local ✓');

  ctx.reset();
  ctx.write(KEYS.tab);

  // The fake's marker only reaches the screen while attached; the attach jiggle repaints it.
  await ctx.waitFor('FAKE_CLAUDE_UP');
}, 15_000);
