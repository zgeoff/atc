import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupMCPHome } from '../src/test-utils/setup-mcp-home';
import { startMCPStdio } from '../src/test-utils/start-mcp-stdio';
import { waitFor } from '../src/test-utils/wait-for';

async function setupTest() {
  const mcpHome = setupMCPHome();

  const mcp = await startMCPStdio({ home: mcpHome.home });

  return { home: mcpHome.home, mcp };
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

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });
  const result = await ctx.mcp.sendToolCall('atc_message_send', { session, text: 'hello' });

  const message = result.structured?.['message'];

  expect(result).toStrictEqual({
    isError: undefined,
    text: `{\n  "message": "${String(message)}",\n  "status": "queued"\n}`,
    structured: { message: expect.stringMatching(/^m-[\da-f-]{36}$/u), status: 'queued' },
  });
});

test('it reads a sent message back through a tool call', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });

  const sent = await ctx.mcp.sendToolCall('atc_message_send', {
    session,
    text: 'hello',
    from: 'tester',
  });

  const message = sent.structured?.['message'];

  const got = await ctx.mcp.sendToolCall('atc_message_get', { message });

  expect(JSON.parse(got.text)).toStrictEqual(got.structured);

  expect(got.structured).toStrictEqual({
    message,
    session,
    from: 'tester',
    text: 'hello',
    status: 'queued',
    sentAt: expect.toBeNumber(),
    turn: null,
    answeredWith: [],
  });
});

test('it holds a message read open while its wait runs', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });

  const sent = await ctx.mcp.sendToolCall('atc_message_send', {
    session,
    text: 'hello',
    from: 'tester',
  });

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

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });

  const sent = await ctx.mcp.sendToolCall('atc_message_send', {
    session,
    text: 'hello',
    from: 'tester',
  });

  const message = sent.structured?.['message'];

  const got = await ctx.mcp.sendToolCall('atc_message_get', { message, waitMs: 1 });

  expect(got.structured).toStrictEqual({
    message,
    session,
    from: 'tester',
    text: 'hello',
    status: 'queued',
    sentAt: expect.toBeNumber(),
    turn: null,
    answeredWith: [],
  });
});
