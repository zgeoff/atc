import { expect, test } from 'bun:test';
import { startStubAgentDaemon } from '@atc/app/test-utils/start-stub-agent-daemon';
import { createGitFixture } from '@atc/core/test-utils/create-git-fixture';
import { startInProcessMCP } from '@atc/mcp/test-utils/start-in-process-mcp';

async function setupTest() {
  const stub = await startStubAgentDaemon();
  const fixture = await createGitFixture({ prefix: 'atc-mcp-record-' });

  const mcp = await startInProcessMCP({
    socketPath: stub.daemon.socketPath,
    build: stub.daemon.build,
  });

  return { home: stub.home, daemon: stub.daemon, fixture, mcp };
}

test("it adds to a session's scope through the MCP tool from outside the session", async () => {
  const ctx = await setupTest();
  const session = await ctx.mcp.spawnSession({ cwd: ctx.fixture.work, name: 'worker' });

  const added = await ctx.mcp.sendToolCall('atc_session_scope_add', {
    session,
    scope: { branches: [{ name: 'main' }] },
  });

  expect(added.isError).toBeUndefined();

  expect(added.structured).toMatchObject({
    record: {
      session,
      scope: { branches: [{ name: 'main', repo: ctx.fixture.work }] },
    },
  });
});

test("it refuses the session's own MCP identity when it adds to its own scope", async () => {
  const ctx = await setupTest();
  const session = await ctx.mcp.spawnSession({ cwd: ctx.fixture.work, name: 'worker' });

  const own = await startInProcessMCP({
    socketPath: ctx.daemon.socketPath,
    build: ctx.daemon.build,
    callerSessionID: session,
  });

  const refused = await own.sendToolCall('atc_session_scope_add', {
    session,
    scope: { branches: [{ name: 'main' }] },
  });

  const after = await ctx.mcp.sendToolCall('atc_session_get', { session });

  expect(refused.isError).toBe(true);

  expect(refused.text).toInclude(
    `session '${session}' cannot add to the scope of session '${session}'`,
  );

  expect(after.structured).toMatchObject({ sessionRecord: { scope: { branches: [] } } });
});
