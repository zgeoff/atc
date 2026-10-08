import { test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEYS } from '../src/test-utils/keys';
import { spawnClaudeSession } from '../src/test-utils/spawn-claude-session';
import { startTUIHarness } from '../src/test-utils/start-tui-harness';

function setupTest() {
  return startTUIHarness();
}

test('it kills a needs-you session from the overlay on confirm', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'testsess');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: testsess');
  await ctx.waitFor('┌ sessions ');

  ctx.write('K');

  await ctx.waitFor('kill selected session?');

  ctx.reset();
  ctx.write('y');

  await ctx.waitFor('killed');
}, 15_000);

test('it revives a killed session in place with a fresh terminal', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.home, 'fake-transcript.jsonl'), '{"type":"user"}\n');

  // The revived process paints only once the test removes this file, after
  // the attach has replayed the killed process's screen.
  writeFileSync(join(ctx.home, 'fake-claude-hold-resume'), '');

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'revivable');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: revivable');
  await ctx.waitFor('┌ sessions ');

  ctx.write('K');

  await ctx.waitFor('kill selected session?');

  ctx.reset();
  ctx.write('y');

  await ctx.waitFor('killed');

  ctx.reset();
  ctx.write('P');

  // The replayed screen of the killed process holds FAKE_CLAUDE_UP, so only
  // the resume argument shows the revived process started.
  await ctx.waitFor('FAKE_CLAUDE_UP');

  rmSync(join(ctx.home, 'fake-claude-hold-resume'));

  await ctx.waitFor('--resume fake-1');
}, 15_000);

test('it explains a revive that has no saved transcript instead of failing silently', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'transcriptless');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: transcriptless');
  await ctx.waitFor('┌ sessions ');

  ctx.write('K');

  await ctx.waitFor('kill selected session?');

  ctx.reset();
  ctx.write('y');

  await ctx.waitFor('killed');

  ctx.reset();
  ctx.write('P');

  await ctx.waitFor('nothing to resume yet');
}, 15_000);
