import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import { startTUIDaemon } from '../../app/src/test-utils/start-tui-daemon';
import { registerTestCleanup } from './register-test-cleanup';
import { spawnClaudeSession } from './spawn-claude-session';
import { startTUIHarness } from './start-tui-harness';

// The client booted to its home screen against a daemon in the test's
// process, and a client of that daemon to read the fleet through.
async function setupTest() {
  const tui = startTUIHarness();

  await startTUIDaemon(tui);

  tui.boot();

  await tui.waitFor('atc — control tower');

  const daemon = await openDaemonClient(join(tui.home, 'atc-daemon.sock'));

  registerTestCleanup(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  return { tui, daemon };
}

test('it spawns a Claude session under the name given in the client home', async () => {
  const ctx = await setupTest();

  await spawnClaudeSession(ctx.tui, 'driven');

  const listed = await ctx.daemon.sendRequest('session.list');

  expect(listed['sessions']).toMatchObject([
    { name: 'driven', cwd: ctx.tui.home, agent: 'claude' },
  ]);
});
