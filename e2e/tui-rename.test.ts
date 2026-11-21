import { test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnClaudeSession } from '@atc/app/test-utils/spawn-claude-session';
import { startTUIHarness } from '@atc/app/test-utils/start-tui-harness';
import { KEYS } from '@atc/core/test-utils/keys';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';

function setupTest() {
  return startTUIHarness({ createStateDB: createMigratedStateDB });
}

test('it renames a session from the claude transcript custom-title', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, 'fake-transcript.jsonl'),
    `${JSON.stringify({ type: 'custom-title', customTitle: 'claude-named', sessionId: 'fake-1' })}\n`,
  );

  ctx.boot();

  await ctx.waitFor('n  new');

  await spawnClaudeSession(ctx, 'typedname');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('claude-named');
});
