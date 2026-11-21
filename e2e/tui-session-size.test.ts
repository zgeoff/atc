import { expect, test } from 'bun:test';
import { spawnClaudeSession } from '@atc/app/test-utils/spawn-claude-session';
import { spawnDaemonSession } from '@atc/app/test-utils/spawn-daemon-session';
import { startTUIDaemon } from '@atc/app/test-utils/start-tui-daemon';
import { startTUIHarness } from '@atc/app/test-utils/start-tui-harness';
import { KEYS } from '@atc/core/test-utils/keys';
import { createDaemonClient } from '@atc/protocol/client';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';
import { registerTestCleanup } from '@zgeoff/testing';

// The client attaches to a daemon in the test's process, so a boot loads
// one process instead of two.
async function setupTest() {
  const tui = startTUIHarness({ createStateDB: createMigratedStateDB });

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

  const viewer = createDaemonClient(ctx.paths.daemonSocketPath);

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

  const viewer = createDaemonClient(ctx.paths.daemonSocketPath);

  registerTestCleanup(() => {
    viewer.stop();
  });

  await viewer.sendHello('atc/test');

  const attached = await viewer.sendRequest('session.attach', {
    session: firstID,
    cols: 200,
    rows: 50,
  });

  expect(attached).toStrictEqual({ cols: 110, rows: 29 });
});
