import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startInProcessMCP } from '@atc/mcp/testing';
import { waitFor } from '@atc/test-utils';
import { startStubAgentDaemon } from '../packages/app/src/test-utils/start-stub-agent-daemon';

// The MCP tools in the test's process, against a daemon in it whose Claude is
// the in-process stand-in.
async function setupTest() {
  const stub = await startStubAgentDaemon();

  const mcp = await startInProcessMCP({
    socketPath: stub.daemon.socketPath,
    build: stub.daemon.build,
  });

  return { home: stub.home, mcp };
}

test('it reads a session record through a tool call', async () => {
  const ctx = await setupTest();
  const session = await ctx.mcp.spawnSession({ cwd: ctx.home, prompt: 'say hi' });
  const read = await ctx.mcp.sendToolCall('atc_session_get', { session });

  expect(read.isError).toBeUndefined();
  expect(JSON.parse(read.text)).toStrictEqual(read.structured);

  expect(read.structured).toMatchObject({
    session: { id: session },
    prompt: 'say hi',
    pending: null,
    result: null,
  });
});

test('it pages a session transcript through a tool call', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.home, 'fake-transcript.jsonl'),
    [
      { type: 'user', message: { role: 'user', content: 'hello' } },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
      },
    ]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join(''),
  );

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });

  const page = await waitFor(async () => {
    const read = await ctx.mcp.sendToolCall('atc_transcript_read', { session });

    expect(read.structured).toMatchObject({ rows: [{ text: 'hello' }, { text: 'hi there' }] });

    return read;
  });

  expect(page).toStrictEqual({
    isError: undefined,
    text: expect.toBeString(),
    structured: {
      rows: [
        { role: 'user', text: 'hello', tools: [], at: null },
        { role: 'assistant', text: 'hi there', tools: [], at: null },
      ],
      cursor: expect.toBeString(),
      more: false,
    },
  });

  expect(JSON.parse(page.text)).toStrictEqual(page.structured);
});

test('it reads fleet events through a tool call', async () => {
  const ctx = await setupTest();
  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });
  const read = await ctx.mcp.sendToolCall('atc_events_read', { waitMs: 4000 });

  expect(JSON.parse(read.text)).toStrictEqual(read.structured);
  expect(read.structured?.['events']).toPartiallyContain({ kind: 'started', session });
});

test('it ends an events long-poll with no events when its wait runs out', async () => {
  const ctx = await setupTest();
  const polled = await ctx.mcp.sendToolCall('atc_events_read', { waitMs: 100 });

  expect(polled).toStrictEqual({
    isError: undefined,
    text: expect.toBeString(),
    structured: { events: [], cursor: expect.toBeString(), more: false },
  });
});

test('it answers a session list while an events long-poll is still waiting', async () => {
  const ctx = await setupTest();

  const poll = ctx.mcp.sendToolCall('atc_events_read', { waitMs: 4000 });
  const list = ctx.mcp.sendToolCall('atc_sessions_list', {});

  const first = await Promise.race([poll.then(() => 'poll'), list.then(() => 'list')]);

  // A session start ends the poll, so the test never waits it out.
  await ctx.mcp.spawnSession({ cwd: ctx.home });

  await poll;

  expect(first).toBe('list');
});

test('it ends an events long-poll when a session starts', async () => {
  const ctx = await setupTest();

  const poll = ctx.mcp.sendToolCall('atc_events_read', { waitMs: 4000 });

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });
  const polled = await poll;

  expect(polled).toStrictEqual({
    isError: undefined,
    text: expect.toBeString(),
    structured: {
      events: [
        {
          cursor: expect.toBeString(),
          at: expect.toBeNumber(),
          session,
          name: expect.toBeString(),
          kind: 'started',
          detail: null,
        },
      ],
      cursor: expect.toBeString(),
      more: false,
    },
  });
});
