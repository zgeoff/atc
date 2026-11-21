import { expect, test } from 'bun:test';
import { KEYS } from '@atc/core/test-utils/keys';
import { openAgentStep } from './open-agent-step';
import { startTUIHarness } from './start-tui-harness';

async function setupTest() {
  const tui = startTUIHarness({ createStateDB: () => {} });

  tui.boot();

  await tui.waitFor('no sessions');

  return { tui };
}

test('it returns once the agent step takes keys, so the next key moves the selection', async () => {
  const ctx = await setupTest();

  await openAgentStep(ctx.tui);

  ctx.tui.reset();
  ctx.tui.write(KEYS.down);

  await ctx.tui.waitFor('\u001B[7mGrok');

  expect(ctx.tui.read()).not.toInclude('reading agents');
});
