import { expect, test } from 'bun:test';
import { createMigratedStateDB } from '@atc/store/test-utils';
import { KEYS, startTUIHarness } from '@atc/test-utils';

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
