import { expect, test } from 'bun:test';
import { startTUIHarness } from '@atc/app/test-utils/start-tui-harness';
import { KEYS } from '@atc/core/test-utils/keys';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';

function setupTest() {
  return startTUIHarness({ createStateDB: createMigratedStateDB });
}

test('it quits the client on q from the overlay', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('no sessions');

  ctx.write('q');

  const exitCode = await ctx.waitForExit();

  expect(exitCode).toBe(0);
});
