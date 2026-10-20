import { expect, test } from 'bun:test';
import { setupMCPHome, startDaemonProcess } from '@atc/lifecycle/testing';
import { resolveATCCommand, startMCPStdio } from '@atc/test-utils';

// A daemon of the test's own on a home with the stand-in agents, which the
// `atc mcp` server joins instead of booting one.
async function setupTest() {
  const mcpHome = setupMCPHome();
  const daemon = startDaemonProcess({ command: resolveATCCommand(), home: mcpHome.home });

  await daemon.openClient();

  const mcp = await startMCPStdio({ home: mcpHome.home });

  return { home: mcpHome.home, daemon, mcp };
}

test('it answers a tool call after the daemon restarts under the same server', async () => {
  const ctx = await setupTest();
  const before = await ctx.mcp.sendToolCall('atc_sessions_list', {});

  const firstPID = ctx.daemon.subprocess.pid;

  await ctx.daemon.restart('SIGTERM');
  await ctx.daemon.openClient();

  const after = await ctx.mcp.sendToolCall('atc_sessions_list', {});

  expect(before).toStrictEqual({ isError: undefined, text: '[]', structured: { sessions: [] } });
  expect(ctx.daemon.subprocess.pid).not.toBe(firstPID);
  expect(after).toStrictEqual({ isError: undefined, text: '[]', structured: { sessions: [] } });
});

test('it spawns a session through the server after the daemon restarts', async () => {
  const ctx = await setupTest();

  await ctx.daemon.restart('SIGTERM');
  await ctx.daemon.openClient();

  const id = await ctx.mcp.spawnSession({ cwd: ctx.home, name: 'after-restart' });
  const listed = await ctx.mcp.sendToolCall('atc_sessions_list', {});

  expect(listed.structured).toMatchObject({ sessions: [{ id, name: 'after-restart' }] });
});
