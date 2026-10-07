import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { spawnClaudeSession } from './spawn-claude-session';
import { startTUIHarness } from './start-tui-harness';

// The client booted to its home screen, and a client of the daemon it
// started there to read the fleet through.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tui = stack.use(startTUIHarness());

  tui.boot();

  await tui.waitFor('atc — control tower');

  const daemon = await DaemonClient.open(join(tui.home, 'atc-daemon.sock'));

  stack.defer(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const owned = stack.move();

  return { tui, daemon, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it spawns a Claude session under the name given in the client home', async () => {
  await using ctx = await setupTest();

  await spawnClaudeSession(ctx.tui, 'driven');

  const listed = await ctx.daemon.sendRequest('session.list');

  expect(listed['sessions']).toMatchObject([
    { name: 'driven', cwd: ctx.tui.home, agent: 'claude' },
  ]);
});
