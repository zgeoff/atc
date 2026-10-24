import { expect, test } from 'bun:test';
import { startInProcessMCP } from '@atc/mcp/testing';
import { waitFor } from '@atc/test-utils';
import { startStubAgentDaemon } from '../packages/app/src/test-utils/start-stub-agent-daemon';

// The MCP tools in the test's process, against a daemon in it whose Claude is
// the in-process stand-in, which never opens a message tap.
async function setupTest() {
  const stub = await startStubAgentDaemon({ tapGraceMs: 0 });

  const mcp = await startInProcessMCP({
    socketPath: stub.daemon.socketPath,
    build: stub.daemon.build,
  });

  return { home: stub.home, daemon: stub.daemon, agents: stub.agents, mcp };
}

test('it reports a message to a session with no tap as a failed tool call', async () => {
  const ctx = await setupTest();
  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });

  await waitFor(async () => {
    const listed = await ctx.mcp.sendToolCall('atc_sessions_list', {});

    expect(listed.text).toInclude('"agentSessionID": "fake-1"');
  });

  const result = await ctx.mcp.sendToolCall('atc_message_send', { session, text: 'hello' });

  expect(result).toStrictEqual({
    isError: true,
    text: expect.toStartWith('unsupported:'),
    structured: undefined,
  });
});

test('it sends a message to a session that has not started', async () => {
  const ctx = await setupTest();

  ctx.agents.holdStart('claude');

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });
  const result = await ctx.mcp.sendToolCall('atc_message_send', { session, text: 'hello' });

  const message = result.structured?.['message'];

  expect(result).toStrictEqual({
    isError: undefined,
    text: `{\n  "message": "${String(message)}",\n  "status": "queued"\n}`,
    structured: { message: expect.stringMatching(/^m-[\da-f-]{36}$/u), status: 'queued' },
  });
});

test("it reads a message from the owner's atc mcp back as from the owner", async () => {
  const ctx = await setupTest();

  ctx.agents.holdStart('claude');

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });
  const sent = await ctx.mcp.sendToolCall('atc_message_send', { session, text: 'hello' });

  const message = sent.structured?.['message'];

  const got = await ctx.mcp.sendToolCall('atc_message_get', { message });

  expect(JSON.parse(got.text)).toStrictEqual(got.structured);

  expect(got.structured).toStrictEqual({
    message,
    session,
    from: 'owner',
    sender: { kind: 'owner', name: 'owner' },
    text: 'hello',
    status: 'queued',
    sentAt: expect.toBeNumber(),
    turn: null,
    answeredWith: [],
  });
});

test('it reads a message from a session through its atc mcp back as from that session and its current name', async () => {
  const ctx = await setupTest();

  ctx.agents.holdStart('claude');

  const target = await ctx.mcp.spawnSession({ cwd: ctx.home });
  const sender = await ctx.mcp.spawnSession({ cwd: ctx.home });

  await ctx.mcp.sendToolCall('atc_session_update', { session: sender, name: 'harbor-refactor' });

  const inside = await startInProcessMCP({
    socketPath: ctx.daemon.socketPath,
    build: ctx.daemon.build,
    callerSessionID: sender,
  });

  const sent = await inside.sendToolCall('atc_message_send', { session: target, text: 'hello' });

  const got = await ctx.mcp.sendToolCall('atc_message_get', {
    message: sent.structured?.['message'],
  });

  expect(got.structured).toMatchObject({
    from: 'harbor-refactor',
    sender: { kind: 'session', session: sender, name: 'harbor-refactor' },
  });
});

test('it holds a message read open while its wait runs', async () => {
  const ctx = await setupTest();

  ctx.agents.holdStart('claude');

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });
  const sent = await ctx.mcp.sendToolCall('atc_message_send', { session, text: 'hello' });

  const message = sent.structured?.['message'];
  const held = ctx.mcp.sendToolCall('atc_message_get', { message, waitMs: 30_000 });

  // The read fails when cleanup stops the server; settling it here keeps
  // that failure from going unhandled.
  void Promise.allSettled([held]);

  // The second read goes out after the held one and takes the same path, so
  // its answer shows the held read has reached the daemon's wait.
  await ctx.mcp.sendToolCall('atc_message_get', { message });

  expect(Bun.peek.status(held)).toBe('pending');
});

test('it answers a message read with the unanswered message once its wait ends', async () => {
  const ctx = await setupTest();

  ctx.agents.holdStart('claude');

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });
  const sent = await ctx.mcp.sendToolCall('atc_message_send', { session, text: 'hello' });

  const message = sent.structured?.['message'];

  const got = await ctx.mcp.sendToolCall('atc_message_get', { message, waitMs: 1 });

  expect(got.structured).toStrictEqual({
    message,
    session,
    from: 'owner',
    sender: { kind: 'owner', name: 'owner' },
    text: 'hello',
    status: 'queued',
    sentAt: expect.toBeNumber(),
    turn: null,
    answeredWith: [],
  });
});
