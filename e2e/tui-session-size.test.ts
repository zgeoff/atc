import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import {
  KEYS,
  registerTestCleanup,
  spawnClaudeSession,
  spawnDaemonSession,
  startTUIHarness,
} from '@atc/test-utils';
import { startTUIDaemon } from '../packages/app/src/test-utils/start-tui-daemon';

// The client attaches to a daemon in the test's process, so a boot loads
// one process instead of two.
async function setupTest() {
  const tui = startTUIHarness();

  await startTUIDaemon(tui);

  return tui;
}

test('it sizes a session to the client that shows it once another client moves to a second session', async () => {
  const ctx = await setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  const firstID = await spawnDaemonSession(ctx, 'first');

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('┌ sessions ');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('FAKE_CLAUDE_UP');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('┌ sessions ');

  await spawnClaudeSession(ctx, 'second');

  const viewer = await openDaemonClient(join(ctx.home, 'atc-daemon.sock'));

  registerTestCleanup(() => {
    viewer.stop();
  });

  await viewer.sendHello('atc/test');

  const attached = await viewer.sendRequest('session.attach', {
    session: firstID,
    cols: 200,
    rows: 50,
  });

  expect(attached).toStrictEqual({ cols: 200, rows: 50 });
});

test('it sizes a session to the smaller of two clients that both show it', async () => {
  const ctx = await setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  const firstID = await spawnDaemonSession(ctx, 'first');

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('┌ sessions ');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('FAKE_CLAUDE_UP');

  const viewer = await openDaemonClient(join(ctx.home, 'atc-daemon.sock'));

  registerTestCleanup(() => {
    viewer.stop();
  });

  await viewer.sendHello('atc/test');

  const attached = await viewer.sendRequest('session.attach', {
    session: firstID,
    cols: 200,
    rows: 50,
  });

  expect(attached).toStrictEqual({ cols: 110, rows: 30 });
});
