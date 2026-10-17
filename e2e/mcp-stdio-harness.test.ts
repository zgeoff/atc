import { expect, test } from 'bun:test';
import { setupMCPHome } from '@atc/lifecycle/testing';
import { startMCPStdio } from '@atc/test-utils';

// A home with the stand-in agents registered, for the real `atc mcp` server
// each test starts there.
function setupTest() {
  const mcpHome = setupMCPHome();

  return { home: mcpHome.home };
}

test('it resolves a request with its whole response under the next id', async () => {
  const ctx = setupTest();

  const mcp = await startMCPStdio({ home: ctx.home });
  const response = await mcp.sendRequest('ping');

  expect(response).toStrictEqual({ jsonrpc: '2.0', id: 2, result: {} });
});

test('it resolves a tool call with its error flag, text, and structured content', async () => {
  const ctx = setupTest();

  const mcp = await startMCPStdio({ home: ctx.home });
  const result = await mcp.sendToolCall('atc_sessions_list', {});

  expect(result).toStrictEqual({ isError: undefined, text: '[]', structured: { sessions: [] } });
});

test('it resolves a spawn with the id of the session it started', async () => {
  const ctx = setupTest();

  const mcp = await startMCPStdio({ home: ctx.home });
  const id = await mcp.spawnSession({ cwd: ctx.home, name: 'harness' });
  const listed = await mcp.sendToolCall('atc_sessions_list', {});

  expect(listed.structured).toMatchObject({ sessions: [{ id, name: 'harness' }] });
});

test('it rejects a spawn the server refuses', async () => {
  const ctx = setupTest();

  const mcp = await startMCPStdio({ home: ctx.home });

  expect(mcp.spawnSession({ cwd: ctx.home, agent: 'gemini' })).rejects.toThrowWithMessage(
    TypeError,
    /^spawn returned no session id: unsupported: no adapter for agent 'gemini'/u,
  );
});

test('it starts a server that runs inside the caller session', async () => {
  const ctx = setupTest();

  const mcp = await startMCPStdio({ home: ctx.home });
  const parent = await mcp.spawnSession({ cwd: ctx.home, name: 'parent' });
  const inner = await startMCPStdio({ home: ctx.home, callerSessionID: parent });
  const child = await inner.sendToolCall('atc_session_spawn', { cwd: ctx.home, name: 'child' });

  expect(child.structured).toMatchObject({ name: 'child', parent });
});

test('it rejects a request still pending when the server stops', async () => {
  const ctx = setupTest();

  const mcp = await startMCPStdio({ home: ctx.home });

  const held = mcp.sendToolCall('atc_events_read', { waitMs: 4000 });

  // The helper's own release awaits this stop once the test finishes.
  void mcp.stop();
  expect(held).rejects.toThrowWithMessage(Error, /^atc mcp stopped answering before request 2$/u);
});
