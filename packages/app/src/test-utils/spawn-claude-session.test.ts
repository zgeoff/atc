import { expect, test } from 'bun:test';
import { createDaemonClient } from '@atc/protocol/client';
import { registerTestCleanup } from '@zgeoff/testing';
import { spawnClaudeSession } from './spawn-claude-session';
import { startTUIDaemon } from './start-tui-daemon';
import { startTUIHarness } from './start-tui-harness';

async function setupTest() {
  const tui = startTUIHarness({ createStateDB: () => {} });

  await startTUIDaemon(tui);

  tui.boot();

  await tui.waitFor('atc — control tower');

  const daemon = createDaemonClient(tui.paths.daemonSocketPath);

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
