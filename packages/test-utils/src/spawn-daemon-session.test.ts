import { expect, test } from 'bun:test';
import { KEYS } from './keys';
import { spawnDaemonSession } from './spawn-daemon-session';
import { startTUIHarness } from './start-tui-harness';

// The client booted to its home screen, with the daemon it started.
async function setupTest() {
  const tui = startTUIHarness();

  tui.boot();

  await tui.waitFor('atc — control tower');

  return { tui };
}

test('it spawns a session the client lists under the name given', async () => {
  const ctx = await setupTest();
  const id = await spawnDaemonSession(ctx.tui, 'beacon');

  ctx.tui.reset();
  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('beacon');

  expect(id).toBeString();
}, 15_000);
