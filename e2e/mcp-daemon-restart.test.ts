import { expect, test } from 'bun:test';
import { setupMCPHome } from '@atc/lifecycle/testing/setup-mcp-home';
import { startDaemonProcess } from '@atc/lifecycle/testing/start-daemon-process';
import { resolveATCCommand } from '@atc/test-utils/resolve-atc-command';
import { startMCPStdio } from '@atc/test-utils/start-mcp-stdio';

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

  const firstPID = ctx.daemon.proc.pid;

  await ctx.daemon.restart('SIGTERM');
  await ctx.daemon.openClient();

  const after = await ctx.mcp.sendToolCall('atc_sessions_list', {});

  expect(before).toStrictEqual({ isError: undefined, text: '[]', structured: { sessions: [] } });
  expect(ctx.daemon.proc.pid).not.toBe(firstPID);
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
