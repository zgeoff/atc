import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEYS } from '../src/test-utils/keys';
import { spawnClaudeSession } from '../src/test-utils/spawn-claude-session';
import { startTUIHarness } from '../src/test-utils/start-tui-harness';
import { waitFor } from '../src/test-utils/wait-for';

function setupTest() {
  return startTUIHarness();
}

test('it clears the need state when attaching a needy session', async () => {
  await using ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'needytest');

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: needytest');

  ctx.write(KEYS.enter);

  await waitFor(
    () => {
      expect(
        readFileSync(join(ctx.home, '.local', 'state', 'atc', 'status.json'), 'utf8'),
      ).toInclude('"needs_you":0');
    },
    { timeoutMs: 3000 },
  );
});

test('it attaches and acks the session that needs you on tab', async () => {
  await using ctx = setupTest();

  const statusPath = join(ctx.home, '.local', 'state', 'atc', 'status.json');

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'needy');

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: needy');

  // Attaching needy clears its need; the attach jiggle repaints the fake.
  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('FAKE_CLAUDE_UP');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('sessions');

  await spawnClaudeSession(ctx, 'urgent');

  // The freshly spawned session goes needs-you on its own notification,
  // observable through the statusline contract file while attached.
  await waitFor(() => {
    expect(readFileSync(statusPath, 'utf8')).toInclude('"needs_you":1');
  });

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('sessions');

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
  await using ctx = setupTest();

  // The fake reports a finished turn instead of a notification, so its
  // session lands done with nothing needing you.
  writeFileSync(
    join(ctx.home, 'fake-claude-events.jsonl'),
    `${JSON.stringify({ hook_event_name: 'Stop', session_id: 'fake-1' })}\n`,
  );

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'finished');

  await waitFor(() => {
    expect(readFileSync(join(ctx.home, '.local', 'state', 'atc', 'status.json'), 'utf8')).toInclude(
      '"done":1',
    );
  });

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('sessions');

  ctx.reset();
  ctx.write(KEYS.tab);

  // Tab attaches the finished session: the attach jiggle repaints the fake,
  // whose marker only reaches the screen while attached.
  await ctx.waitFor('FAKE_CLAUDE_UP');
}, 15_000);
