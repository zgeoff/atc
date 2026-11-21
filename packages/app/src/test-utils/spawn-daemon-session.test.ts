import { expect, test } from 'bun:test';
import { KEYS } from '@atc/core/test-utils/keys';
import { spawnDaemonSession } from './spawn-daemon-session';
import { startTUIHarness } from './start-tui-harness';

async function setupTest() {
  const tui = startTUIHarness({ createStateDB: () => {} });

  tui.boot();

  await tui.waitFor('no sessions');

  return { tui };
}

test('it spawns a session the client lists under the name given', async () => {
  const ctx = await setupTest();
  const id = await spawnDaemonSession(ctx.tui, 'beacon');

  ctx.tui.reset();
  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('beacon');

  expect(id).toBeString();
});
