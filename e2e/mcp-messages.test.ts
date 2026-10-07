import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupMCPHome } from '../src/test-utils/setup-mcp-home';
import { startMCPStdio } from '../src/test-utils/start-mcp-stdio';
import { waitFor } from '../src/test-utils/wait-for';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const mcpHome = stack.use(setupMCPHome());

  const mcp = await startMCPStdio({ home: mcpHome.home });

  stack.use(mcp);

  const owned = stack.move();

  return { home: mcpHome.home, mcp, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it reports a message to a session with no tap as a failed tool call', async () => {
  await using ctx = await setupTest();

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });

  await waitFor(async () => {
    const listed = await ctx.mcp.sendToolCall('atc_session_list', {});

    expect(listed.text).toInclude('"agentSessionID": "fake-1"');
  });

  const result = await ctx.mcp.sendToolCall('atc_session_message', { session, text: 'hello' });

  expect(result).toStrictEqual({
    isError: true,
    text: expect.toStartWith('unsupported:'),
    structured: undefined,
  });
});

test('it sends a message to a session that has not started', async () => {
  await using ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });
  const result = await ctx.mcp.sendToolCall('atc_session_message', { session, text: 'hello' });

  expect(result.isError).toBeUndefined();
  expect(result.text).toInclude('"status": "accepted"');
});

test('it reads a sent message back through a tool call', async () => {
  await using ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });

  const sent = await ctx.mcp.sendToolCall('atc_session_message', {
    session,
    text: 'hello',
    from: 'tester',
  });

  const message = sent.structured?.['message'];

  const got = await ctx.mcp.sendToolCall('atc_message_get', { message });

  expect(got.structured).toStrictEqual({
    message,
    session,
    from: 'tester',
    text: 'hello',
    status: 'accepted',
    sentAt: expect.toBeNumber(),
    turn: null,
    answeredWith: [],
  });
});

test('it holds a message read until its wait ends', async () => {
  await using ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });

  const sent = await ctx.mcp.sendToolCall('atc_session_message', {
    session,
    text: 'hello',
    from: 'tester',
  });

  const message = sent.structured?.['message'];
  const start = Date.now();

  const got = await ctx.mcp.sendToolCall('atc_message_get', { message, waitMs: 200 });

  expect(got.structured).toMatchObject({ message, status: 'accepted' });
  expect(Date.now()).toBeWithin(start + 200, start + 5000);
});
