import { expect, test } from 'bun:test';
import { startInProcessMCP } from '@atc/mcp/testing';
import { startStubAgentDaemon } from '../packages/app/src/test-utils/start-stub-agent-daemon';

// The MCP tools in the test's process, against a daemon in it whose Claude is
// the in-process stand-in.
async function setupTest() {
  const stub = await startStubAgentDaemon();

  const mcp = await startInProcessMCP({
    socketPath: stub.daemon.socketPath,
    build: stub.daemon.build,
  });

  return { home: stub.home, daemon: stub.daemon, mcp };
}

test('it nests a spawn from inside a session under that session', async () => {
  const ctx = await setupTest();
  const wrangler = await ctx.mcp.spawnSession({ cwd: ctx.home, name: 'wrangler' });

  const inner = await startInProcessMCP({
    socketPath: ctx.daemon.socketPath,
    build: ctx.daemon.build,
    callerSessionID: wrangler,
  });

  const worker = await inner.sendToolCall('atc_session_spawn', { cwd: ctx.home, name: 'worker' });

  expect(worker.isError).toBeUndefined();
  expect(worker.text).toInclude(`"parent": "${wrangler}"`);
});

test('it spawns a top-level session from inside a session when detached is set', async () => {
  const ctx = await setupTest();
  const wrangler = await ctx.mcp.spawnSession({ cwd: ctx.home, name: 'wrangler' });

  const inner = await startInProcessMCP({
    socketPath: ctx.daemon.socketPath,
    build: ctx.daemon.build,
    callerSessionID: wrangler,
  });

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

  const inner = await startInProcessMCP({
    socketPath: ctx.daemon.socketPath,
    build: ctx.daemon.build,
    callerSessionID: wrangler,
  });

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

  const inner = await startInProcessMCP({
    socketPath: ctx.daemon.socketPath,
    build: ctx.daemon.build,
    callerSessionID: wrangler,
  });

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

test('it forgets its own sub-session from inside its pinned session and stays pinned', async () => {
  const ctx = await setupTest();
  const wrangler = await ctx.mcp.spawnSession({ cwd: ctx.home, name: 'wrangler' });

  const inner = await startInProcessMCP({
    socketPath: ctx.daemon.socketPath,
    build: ctx.daemon.build,
    callerSessionID: wrangler,
  });

  const worker = await inner.spawnSession({ cwd: ctx.home, name: 'worker' });

  await ctx.mcp.sendToolCall('atc_session_update', { session: wrangler, pinned: true });

  const forgotten = await inner.sendToolCall('atc_session_forget', { session: worker, stop: true });
  const listed = await ctx.mcp.sendToolCall('atc_sessions_list', {});

  expect(forgotten.structured).toStrictEqual({ forgotten: true, destroyed: false });

  expect(listed.structured?.['sessions']).toStrictEqual([
    expect.objectContaining({ id: wrangler, pinned: true }),
  ]);
});

test('it refuses a forget from inside another session of a sub-session of a pinned session', async () => {
  const ctx = await setupTest();
  const wrangler = await ctx.mcp.spawnSession({ cwd: ctx.home, name: 'wrangler' });

  const inner = await startInProcessMCP({
    socketPath: ctx.daemon.socketPath,
    build: ctx.daemon.build,
    callerSessionID: wrangler,
  });

  const worker = await inner.spawnSession({ cwd: ctx.home, name: 'worker' });
  const bystander = await ctx.mcp.spawnSession({ cwd: ctx.home, name: 'bystander' });

  const outer = await startInProcessMCP({
    socketPath: ctx.daemon.socketPath,
    build: ctx.daemon.build,
    callerSessionID: bystander,
  });

  await ctx.mcp.sendToolCall('atc_session_update', { session: wrangler, pinned: true });

  const refused = await outer.sendToolCall('atc_session_forget', { session: worker, stop: true });

  expect(refused.text).toStartWith('session_pinned');
});

test('it spawns a top-level session when the caller id matches no session', async () => {
  const ctx = await setupTest();

  const stray = await startInProcessMCP({
    socketPath: ctx.daemon.socketPath,
    build: ctx.daemon.build,
    callerSessionID: 'ghost',
  });

  const spawned = await stray.sendToolCall('atc_session_spawn', { cwd: ctx.home, name: 'stray' });

  expect(spawned.isError).toBeUndefined();
  expect(spawned.text).toInclude('"name": "stray"');
  expect(spawned.text).not.toInclude('"parent"');
});
