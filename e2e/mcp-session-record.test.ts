import { expect, test } from 'bun:test';
import { createGitFixture } from '../src/test-utils/create-git-fixture';
import { setupMCPHome } from '../src/test-utils/setup-mcp-home';
import { startMCPStdio } from '../src/test-utils/start-mcp-stdio';

async function setupTest() {
  const mcpHome = setupMCPHome();

  const fixture = await createGitFixture({ prefix: 'atc-mcp-record-' });
  const mcp = await startMCPStdio({ home: mcpHome.home });

  return { home: mcpHome.home, fixture, mcp };
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
      revision: 2,
      scope: { branches: [{ name: 'main', repo: ctx.fixture.work }] },
    },
  });
});

test("it refuses the session's own MCP identity when it adds to its own scope", async () => {
  const ctx = await setupTest();
  const session = await ctx.mcp.spawnSession({ cwd: ctx.fixture.work, name: 'worker' });
  const own = await startMCPStdio({ home: ctx.home, callerSessionID: session });

  const refused = await own.sendToolCall('atc_session_scope_add', {
    session,
    scope: { branches: [{ name: 'main' }] },
  });

  const after = await ctx.mcp.sendToolCall('atc_session_get', { session });

  expect(refused.isError).toBe(true);

  expect(refused.text).toInclude(
    `session '${session}' cannot add to the scope of session '${session}'`,
  );

  expect(after.structured).toMatchObject({ sessionRecord: { revision: 1 } });
});
