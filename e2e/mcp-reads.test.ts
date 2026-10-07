import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../src/shared/report';
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

test('it reads a session record through a tool call', async () => {
  await using ctx = await setupTest();

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home, prompt: 'say hi' });
  const read = await ctx.mcp.sendToolCall('atc_session_get', { session });

  expect(read.isError).toBeUndefined();

  expect(read.structured).toMatchObject({
    session: { id: session },
    prompt: 'say hi',
    pending: null,
    result: null,
  });
});

test('it pages a session transcript through a tool call', async () => {
  await using ctx = await setupTest();

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
    const read = await ctx.mcp.sendToolCall('atc_session_read', { session });

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
});

test('it reads fleet events through a tool call', async () => {
  await using ctx = await setupTest();

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });
  const read = await ctx.mcp.sendToolCall('atc_events_read', { waitMs: 30_000 });

  expect(read.structured).toMatchObject({
    events: expect.toPartiallyContain({ kind: 'started', session }),
  });
});

test('it reads the whole text of a report its event previews through a tool call', async () => {
  await using ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-note'), `${'option '.repeat(150)}end`);

  await ctx.mcp.spawnSession({ cwd: ctx.home });

  const event = await waitFor(async () => {
    const read = await ctx.mcp.sendToolCall('atc_events_read', {});

    const events = isRecord(read.structured) ? read.structured['events'] : undefined;

    const found: unknown = Array.isArray(events)
      ? events.find((candidate: unknown) => isRecord(candidate) && candidate['kind'] === 'report')
      : undefined;

    if (!isRecord(found)) {
      throw new TypeError('no report event yet');
    }

    return found;
  });

  const report = await ctx.mcp.sendToolCall('atc_report_get', { report: event['cursor'] });

  expect({ preview: event['detail'], report: report.structured }).toStrictEqual({
    preview: `${'option '.repeat(150).slice(0, 599)}…`,
    report: {
      report: event['cursor'],
      at: event['at'],
      session: event['session'],
      name: event['name'],
      label: 'decision',
      text: `${'option '.repeat(150)}end`,
      complete: true,
    },
  });
});

test('it answers a session list while an events long-poll is still waiting', async () => {
  await using ctx = await setupTest();

  const poll = ctx.mcp.sendToolCall('atc_events_read', { waitMs: 30_000 });
  const list = ctx.mcp.sendToolCall('atc_session_list', {});

  const first = await Promise.race([poll.then(() => 'poll'), list.then(() => 'list')]);

  expect(first).toBe('list');

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
