import { expect, test } from 'bun:test';
import { startTUIHarness } from '@atc/app/test-utils/start-tui-harness';
import { resolvePaths } from '@atc/config';
import { resolveATCCommand } from '@atc/core/test-utils/resolve-atc-command';
import { startDaemonProcess } from '@atc/lifecycle/test-utils/start-daemon-process';
import { spawnNamedSession } from '@atc/protocol/test-utils/spawn-named-session';
import { createStateStore } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';
import { registerTestCleanup, waitFor } from '@zgeoff/testing';

function setupTest() {
  return startTUIHarness({ createStateDB: createMigratedStateDB });
}

test('it restores the fleet from disk after a crash', async () => {
  const ctx = setupTest();
  const daemon = startDaemonProcess({ command: resolveATCCommand(), home: ctx.home, env: ctx.env });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  await spawnNamedSession(
    (method, params) => client.sendRequest(method, params),
    'fleettest',
    ctx.home,
  );

  const store = await createStateStore(resolvePaths({ HOME: ctx.home }).dbFile);

  registerTestCleanup(() => store.stop());

  // The row lands at spawn, before the agent reports its session id, so
  // the wait runs until the row holds that id.
  await waitFor(async () => {
    const fleet = await store.loadFleet();

    expect(fleet).toStrictEqual([
      expect.objectContaining({ name: 'fleettest', cwd: ctx.home, agentSessionID: 'fake-1' }),
    ]);
  });

  daemon.subprocess.kill('SIGKILL');

  await daemon.subprocess.exited;

  ctx.boot();

  await ctx.waitFor('R  restore');

  ctx.reset();
  ctx.write('R');

  await ctx.waitFor('FAKE_CLAUDE_UP');
  await ctx.waitFor('--resume fake-1');
});

test('it restores a grok session with grok --resume after a crash', async () => {
  const ctx = setupTest();
  const daemon = startDaemonProcess({ command: resolveATCCommand(), home: ctx.home, env: ctx.env });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    name: 'grokfleet',
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const store = await createStateStore(resolvePaths({ HOME: ctx.home }).dbFile);

  registerTestCleanup(() => store.stop());

  // The row lands at spawn, before the agent reports its session id, so
  // the wait runs until the row holds that id.
  await waitFor(async () => {
    const fleet = await store.loadFleet();

    expect(fleet).toStrictEqual([
      expect.objectContaining({
        name: 'grokfleet',
        cwd: ctx.home,
        agentSessionID: 'fake-grok-1',
        agent: 'grok',
      }),
    ]);
  });

  daemon.subprocess.kill('SIGKILL');

  await daemon.subprocess.exited;

  ctx.boot();

  await ctx.waitFor('R  restore');

  ctx.reset();
  ctx.write('R');

  await ctx.waitFor('FAKE_GROK_UP');
  await ctx.waitFor('--resume fake-grok-1');

  expect(ctx.read()).not.toInclude('claude --resume');
  expect(ctx.read()).not.toInclude('FAKE_CLAUDE_UP');
}, 15_000);
