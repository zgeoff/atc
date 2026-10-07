import { expect, test } from 'bun:test';
import { setupMCPHome } from '../src/test-utils/setup-mcp-home';
import { startMCPStdio } from '../src/test-utils/start-mcp-stdio';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const mcpHome = stack.use(setupMCPHome());

  const mcp = await startMCPStdio({ home: mcpHome.home });

  stack.use(mcp);

  const owned = stack.move();

  return { home: mcpHome.home, mcp, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it nests a spawn from inside a session under that session', async () => {
  await using ctx = await setupTest();

  const wrangler = await ctx.mcp.spawnSession({ cwd: ctx.home, name: 'wrangler' });

  await using inner = await startMCPStdio({ home: ctx.home, callerSessionID: wrangler });

  const worker = await inner.sendToolCall('atc_session_spawn', { cwd: ctx.home, name: 'worker' });

  expect(worker.isError).toBeUndefined();
  expect(worker.text).toInclude(`"parent": "${wrangler}"`);
});

test('it spawns a top-level session from inside a session when detached is set', async () => {
  await using ctx = await setupTest();

  const wrangler = await ctx.mcp.spawnSession({ cwd: ctx.home, name: 'wrangler' });

  await using inner = await startMCPStdio({ home: ctx.home, callerSessionID: wrangler });

  const solo = await inner.sendToolCall('atc_session_spawn', {
    cwd: ctx.home,
    name: 'solo',
    detached: true,
  });

  expect(solo.isError).toBeUndefined();
  expect(solo.text).toInclude('"name": "solo"');
  expect(solo.text).not.toInclude('"parent"');
});

test('it spawns a top-level session when the caller id matches no session', async () => {
  await using ctx = await setupTest();
  await using stray = await startMCPStdio({ home: ctx.home, callerSessionID: 'ghost' });

  const spawned = await stray.sendToolCall('atc_session_spawn', { cwd: ctx.home, name: 'stray' });

  expect(spawned.isError).toBeUndefined();
  expect(spawned.text).toInclude('"name": "stray"');
  expect(spawned.text).not.toInclude('"parent"');
});
