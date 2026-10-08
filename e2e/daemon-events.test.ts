import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRecord } from '../src/shared/get-record';
import { createStubClaude } from '../src/test-utils/create-stub-claude';
import { createStubComposer } from '../src/test-utils/create-stub-composer';
import { getRecords } from '../src/test-utils/get-records';
import { getString } from '../src/test-utils/get-string';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { startDaemonProcess } from '../src/test-utils/start-daemon-process';
import { waitFor } from '../src/test-utils/wait-for';

/**
 * A home with a stub Claude CLI and a config that offers it, served by an
 * `atc daemon` process, with a client that has sent its handshake.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-e2e-events-');
  const atc = resolveATCCommand();
  const claude = createStubClaude(tmp.dir, { atc, composer: createStubComposer(tmp.dir) });

  // The daemon spawns its sessions from the agents the config offers.
  mkdirSync(join(tmp.dir, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(tmp.dir, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { bin: claude },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: atc, home: tmp.dir });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  return { home: tmp.dir, client };
}

test('it reads hook events from the start through events.read', async () => {
  const ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    name: 'watched',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  const answer = await waitFor(async () => {
    const read = await ctx.client.sendRequest('events.read', {});

    expect(getRecords(read, 'events')).toHaveLength(2);

    return read;
  });

  expect(answer).toStrictEqual({
    events: [
      {
        cursor: expect.toBeString(),
        at: expect.toBeNumber(),
        session: id,
        name: 'watched',
        kind: 'started',
        detail: null,
      },
      {
        cursor: expect.toBeString(),
        at: expect.toBeNumber(),
        session: id,
        name: 'watched',
        kind: 'needs-input',
        detail: 'needs permission',
      },
    ],
    cursor: expect.toBeString(),
    more: false,
  });
});

test('it reads nothing past the cursor of the last event through events.read', async () => {
  const ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const first = await waitFor(async () => {
    const read = await ctx.client.sendRequest('events.read', {});

    expect(getRecords(read, 'events')).toHaveLength(2);

    return read;
  });

  const cursor = getString(first, 'cursor');

  const next = await ctx.client.sendRequest('events.read', { cursor });

  expect(next).toStrictEqual({ events: [], cursor, more: false });
});

test('it holds events.read open until the next event arrives', async () => {
  const ctx = await setupTest();
  const first = await ctx.client.sendRequest('events.read', {});

  // The longest hold the daemon allows outlasts the test's own deadline, so
  // only an answer the next event releases lets the test finish.
  const pending = ctx.client.sendRequest('events.read', {
    cursor: first['cursor'],
    waitMs: 30_000,
  });

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    name: 'late',
    cols: 80,
    rows: 24,
  });

  const answered = await pending;

  expect(answered).toMatchObject({
    events: [{ kind: 'started', session: getRecord(ok, 'session')['id'] }],
  });
});

test("it reads the first page of a claude session's transcript through session.read", async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.home, 'fake-transcript.jsonl'),
    [
      {
        type: 'user',
        message: { role: 'user', content: 'fix the auth bug' },
        timestamp: '2026-10-01T10:00:00.000Z',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Running the tests.' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bun test' } },
          ],
        },
        timestamp: '2026-10-01T10:00:05.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
        },
        timestamp: '2026-10-01T10:00:06.000Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'All green.' }] },
        timestamp: '2026-10-01T10:00:09.000Z',
      },
    ]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join(''),
  );

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  // The transcript reads once the session's start has bound its path.
  const page = await waitFor(async () => {
    const read = await ctx.client.sendRequest('session.read', { session: id, limit: 2 });

    expect(getRecords(read, 'rows')).toHaveLength(2);

    return read;
  });

  expect(page).toStrictEqual({
    rows: [
      {
        role: 'user',
        text: 'fix the auth bug',
        tools: [],
        at: Date.parse('2026-10-01T10:00:00.000Z'),
      },
      {
        role: 'assistant',
        text: 'Running the tests.',
        tools: [{ name: 'Bash', input: 'bun test' }],
        at: Date.parse('2026-10-01T10:00:05.000Z'),
      },
    ],
    cursor: expect.toBeString(),
    more: true,
  });
});

test("it reads the rest of a claude session's transcript from a page cursor", async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.home, 'fake-transcript.jsonl'),
    [
      {
        type: 'user',
        message: { role: 'user', content: 'fix the auth bug' },
        timestamp: '2026-10-01T10:00:00.000Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Running the tests.' }] },
        timestamp: '2026-10-01T10:00:05.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
        },
        timestamp: '2026-10-01T10:00:06.000Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'All green.' }] },
        timestamp: '2026-10-01T10:00:09.000Z',
      },
    ]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join(''),
  );

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  const first = await waitFor(async () => {
    const read = await ctx.client.sendRequest('session.read', { session: id, limit: 2 });

    expect(getRecords(read, 'rows')).toHaveLength(2);

    return read;
  });

  const second = await ctx.client.sendRequest('session.read', {
    session: id,
    cursor: first['cursor'],
    limit: 2,
  });

  expect(second).toStrictEqual({
    rows: [
      {
        role: 'assistant',
        text: 'All green.',
        tools: [],
        at: Date.parse('2026-10-01T10:00:09.000Z'),
      },
    ],
    cursor: expect.toBeString(),
    more: false,
  });
});

test("it reads a line appended to a claude session's transcript from the last cursor", async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.home, 'fake-transcript.jsonl'),
    `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'fix the auth bug' },
      timestamp: '2026-10-01T10:00:00.000Z',
    })}\n`,
  );

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  const first = await waitFor(async () => {
    const read = await ctx.client.sendRequest('session.read', { session: id, limit: 2 });

    expect(getRecords(read, 'rows')).toHaveLength(1);

    return read;
  });

  appendFileSync(
    join(ctx.home, 'fake-transcript.jsonl'),
    `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'thanks' },
      timestamp: '2026-10-01T10:01:00.000Z',
    })}\n`,
  );

  const next = await ctx.client.sendRequest('session.read', {
    session: id,
    cursor: first['cursor'],
    limit: 2,
  });

  expect(next).toStrictEqual({
    rows: [{ role: 'user', text: 'thanks', tools: [], at: Date.parse('2026-10-01T10:01:00.000Z') }],
    cursor: expect.toBeString(),
    more: false,
  });
});
