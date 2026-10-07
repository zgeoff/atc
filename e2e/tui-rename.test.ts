import { test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEYS } from '../src/test-utils/keys';
import { spawnClaudeSession } from '../src/test-utils/spawn-claude-session';
import { startTUIHarness } from '../src/test-utils/start-tui-harness';

function setupTest() {
  return startTUIHarness();
}

test('it renames a session from the claude transcript custom-title', async () => {
  await using ctx = setupTest();

  writeFileSync(
    join(ctx.home, 'fake-transcript.jsonl'),
    `${JSON.stringify({ type: 'custom-title', customTitle: 'claude-named', sessionId: 'fake-1' })}\n`,
  );

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnClaudeSession(ctx, 'typedname');

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('claude-named');
});
