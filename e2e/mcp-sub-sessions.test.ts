import { expect, test } from 'bun:test';
import { setupMCPHome } from '@atc/lifecycle/testing/setup-mcp-home';
import { startMCPStdio } from '@atc/test-utils/start-mcp-stdio';

async function setupTest() {
  const mcpHome = setupMCPHome();

  const mcp = await startMCPStdio({ home: mcpHome.home });

  return { home: mcpHome.home, mcp };
}

test('it nests a spawn from inside a session under that session', async () => {
  const ctx = await setupTest();
  const wrangler = await ctx.mcp.spawnSession({ cwd: ctx.home, name: 'wrangler' });
  const inner = await startMCPStdio({ home: ctx.home, callerSessionID: wrangler });
  const worker = await inner.sendToolCall('atc_session_spawn', { cwd: ctx.home, name: 'worker' });

  expect(worker.isError).toBeUndefined();
  expect(worker.text).toInclude(`"parent": "${wrangler}"`);
});

test('it spawns a top-level session from inside a session when detached is set', async () => {
  const ctx = await setupTest();
  const wrangler = await ctx.mcp.spawnSession({ cwd: ctx.home, name: 'wrangler' });
  const inner = await startMCPStdio({ home: ctx.home, callerSessionID: wrangler });

  const solo = await inner.sendToolCall('atc_session_spawn', {
    cwd: ctx.home,
    name: 'solo',
    detached: true,
  });

  expect(solo.isError).toBeUndefined();
  expect(solo.text).toInclude('"name": "solo"');
  expect(solo.text).not.toInclude('"parent"');
});

test('it leaves a detached spawn unpinned and forgettable when its caller is pinned', async () => {
  const ctx = await setupTest();
  const wrangler = await ctx.mcp.spawnSession({ cwd: ctx.home, name: 'wrangler' });
  const inner = await startMCPStdio({ home: ctx.home, callerSessionID: wrangler });
  const solo = await inner.spawnSession({ cwd: ctx.home, name: 'solo', detached: true });

  await ctx.mcp.sendToolCall('atc_session_update', { session: wrangler, pinned: true });

  const listed = await ctx.mcp.sendToolCall('atc_sessions_list', {});
  const forgotten = await ctx.mcp.sendToolCall('atc_session_forget', { session: solo, stop: true });

  expect(listed.structured?.['sessions']).toIncludeAllPartialMembers([
    { id: wrangler, pinned: true },
    { id: solo, pinned: false },
  ]);

  expect(listed.structured?.['sessions']).not.toPartiallyContain({ id: solo, parent: wrangler });
  expect(forgotten.isError).toBeUndefined();
  expect(forgotten.structured).toStrictEqual({ forgotten: true, destroyed: false });
});

test('it forgets a detached sub-session while its former parent stays pinned', async () => {
  const ctx = await setupTest();
  const wrangler = await ctx.mcp.spawnSession({ cwd: ctx.home, name: 'wrangler' });
  const inner = await startMCPStdio({ home: ctx.home, callerSessionID: wrangler });
  const worker = await inner.spawnSession({ cwd: ctx.home, name: 'worker' });

  await ctx.mcp.sendToolCall('atc_session_update', { session: wrangler, pinned: true });

  const refused = await ctx.mcp.sendToolCall('atc_session_forget', {
    session: worker,
    stop: true,
  });

  const detached = await inner.sendToolCall('atc_session_update', {
    session: worker,
    parent: null,
  });

  const forgotten = await ctx.mcp.sendToolCall('atc_session_forget', {
    session: worker,
    stop: true,
  });

  const listed = await ctx.mcp.sendToolCall('atc_sessions_list', {});

  expect(refused.text).toStartWith('session_pinned');
  expect(detached.isError).toBeUndefined();
  expect(forgotten.structured).toStrictEqual({ forgotten: true, destroyed: false });

  expect(listed.structured?.['sessions']).toStrictEqual([
    expect.objectContaining({ id: wrangler, pinned: true }),
  ]);
});

test('it spawns a top-level session when the caller id matches no session', async () => {
  const ctx = await setupTest();
  const stray = await startMCPStdio({ home: ctx.home, callerSessionID: 'ghost' });
  const spawned = await stray.sendToolCall('atc_session_spawn', { cwd: ctx.home, name: 'stray' });

  expect(spawned.isError).toBeUndefined();
  expect(spawned.text).toInclude('"name": "stray"');
  expect(spawned.text).not.toInclude('"parent"');
});
