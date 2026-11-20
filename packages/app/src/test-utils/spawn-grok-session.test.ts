import { expect, test } from 'bun:test';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { createDaemonClient } from '@atc/protocol/client';
import { spawnGrokSession } from './spawn-grok-session';
import { startTUIHarness } from './start-tui-harness';

async function setupTest() {
  const tui = startTUIHarness({ createStateDB: () => {} });

  tui.boot();

  await tui.waitFor('atc — control tower');

  const daemon = createDaemonClient(tui.paths.daemonSocketPath);

  registerTestCleanup(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  return { tui, daemon };
}

test('it spawns a Grok session under the name given in the client home', async () => {
  const ctx = await setupTest();

  await spawnGrokSession(ctx.tui, 'driven');

  const listed = await ctx.daemon.sendRequest('session.list');

  expect(listed['sessions']).toMatchObject([{ name: 'driven', cwd: ctx.tui.home, agent: 'grok' }]);
});
