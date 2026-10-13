import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupMCPHome } from '@atc/lifecycle/testing/setup-mcp-home';
import { startMCPStdio } from '@atc/test-utils/start-mcp-stdio';
import { waitFor } from '@atc/test-utils/wait-for';

async function setupTest() {
  const mcpHome = setupMCPHome();

  const mcp = await startMCPStdio({ home: mcpHome.home });

  return { home: mcpHome.home, mcp };
}

test('it reports a rename it skipped because the agent named the session itself', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.home, 'fake-transcript.jsonl'),
    `${JSON.stringify({ type: 'custom-title', customTitle: 'claude-named', sessionId: 'fake-1' })}\n`,
  );

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home, name: 'typed' });

  await waitFor(async () => {
    const named = await ctx.mcp.sendToolCall('atc_sessions_list', {});

    expect(named.structured?.['sessions']).toStrictEqual([
      expect.objectContaining({ id: session, name: 'claude-named' }),
    ]);
  });

  const updated = await ctx.mcp.sendToolCall('atc_session_update', {
    session,
    name: 'from-mcp',
    pinned: true,
  });

  const listed = await ctx.mcp.sendToolCall('atc_sessions_list', {});

  expect(updated.isError).toBeUndefined();

  expect(updated.text).toBe(
    'updated, not renamed: the agent named this session itself with /rename, and a name the agent sets wins over one set here. Any pin or detach in the call applied.',
  );

  expect(listed.structured?.['sessions']).toStrictEqual([
    expect.objectContaining({ id: session, name: 'claude-named', pinned: true }),
  ]);
});

test('it renames a session the agent has not named', async () => {
  const ctx = await setupTest();
  const session = await ctx.mcp.spawnSession({ cwd: ctx.home, name: 'typed' });
  const updated = await ctx.mcp.sendToolCall('atc_session_update', { session, name: 'from-mcp' });
  const listed = await ctx.mcp.sendToolCall('atc_sessions_list', {});

  expect(updated.text).toBe('updated');

  expect(listed.structured?.['sessions']).toStrictEqual([
    expect.objectContaining({ id: session, name: 'from-mcp' }),
  ]);
});
