import { expect, test } from 'bun:test';
import { KEYS } from '../src/test-utils/keys';
import { startTUIHarness } from '../src/test-utils/start-tui-harness';

function setupTest() {
  return startTUIHarness();
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
