import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { CODEX_PLUGIN, createCodexAdapter } from '@atc/harness-codex';
import {
  createStubAppServerCodex,
  getAgentEntry,
  getRecord,
  getString,
  setupTempDir,
  startCodexTerminalThread,
  waitFor,
} from '@atc/test-utils';
import { z } from 'zod';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// A daemon whose one agent is a Codex entry on an App Server, run by the
// stand-in Codex CLI, which reads its scenario from the stub folder and
// logs every request it takes there.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-codex-app-server-');
  const bin = createStubAppServerCodex(temporaryDirectory.path);

  const codex = createCodexAdapter(
    getAgentEntry(
      parseConfig([CODEX_PLUGIN], { agents: { codex: { bin, appServer: true } } }),
      'codex',
    ),
  );

  const daemon = await startTestDaemon({ options: () => ({ adapter: codex }) });

  return {
    daemon,
    stubDir: temporaryDirectory.path,
    readRequests: () =>
      readFileSync(join(temporaryDirectory.path, 'app-server-requests.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) =>
          z.object({ method: z.string(), params: z.unknown() }).parse(JSON.parse(line)),
        ),
  };
}

test('it delivers a message to a Codex session through its App Server and stores the answer', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.stubDir, 'app-server-scenario.json'),
    JSON.stringify({ reply: 'the build passes' }),
  );

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'check the build',
  });

  const answered = await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('message.get', { message: sent['message'] });

    expect(read['status']).toBe('answered');

    return read;
  });

  expect(answered).toMatchObject({
    message: sent['message'],
    session: id,
    status: 'answered',
    answer: 'the build passes',
  });

  expect(ctx.readRequests()).toPartiallyContain({
    method: 'turn/start',
    params: {
      threadId: 'thread-1',
      input: [
        {
          type: 'text',
          text: `<atc-message id="${String(sent['message'])}" from="owner" kind="owner">\ncheck the build\n</atc-message>`,
          text_elements: [],
        },
      ],
      clientUserMessageId: sent['message'],
    },
  });
});

test('it keeps the stored message states when a history read fails during recovery', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.stubDir, 'app-server-scenario.json'),
    JSON.stringify({ holdTurns: true, dropOnTurnStart: 2, failTurnsListFrom: 2 }),
  );

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  const accepted = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'check the build',
  });

  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('message.get', {
      message: accepted['message'],
    });

    expect(read['status']).toBe('delivered');
  });

  const taken = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'and the lint',
  });

  await waitFor(() => {
    expect(
      ctx.readRequests().filter((request) => request.method === 'thread/turns/list').length,
    ).toBeGreaterThan(1);
  });

  const first = await ctx.daemon.client.sendRequest('message.get', {
    message: accepted['message'],
  });

  const second = await ctx.daemon.client.sendRequest('message.get', { message: taken['message'] });

  expect(first['status']).toBe('delivered');
  expect(second['status']).toBe('queued');
  expect(ctx.readRequests().filter((request) => request.method === 'turn/start')).toHaveLength(2);
});

test('it resends no accepted message when its turn completes while the connection is set up', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.stubDir, 'app-server-scenario.json'),
    JSON.stringify({
      reply: 'answered once',
      holdTurns: true,
      dropOnTurnStart: 1,
      completeHeldTurnsOnResume: true,
    }),
  );

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'check the build',
  });

  const answered = await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('message.get', { message: sent['message'] });

    expect(read['status']).toBe('answered');

    return read;
  });

  expect(answered['answer']).toBe('answered once');
  expect(ctx.readRequests().filter((request) => request.method === 'turn/start')).toHaveLength(1);
  expect(ctx.readRequests().map((request) => request.method)).toContain('thread/resume');
});

test('it starts the terminal against the session App Server on the bridge thread', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  const screen = await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('session.screen', { session: id });

    expect(JSON.stringify(read)).toInclude('FAKE_CODEX_UP');

    return JSON.stringify(read);
  });

  expect(screen).toInclude('resume thread-1 --remote unix://');
});

test('it leaves each message the App Server refuses unanswered and goes on to the next', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.stubDir, 'app-server-scenario.json'),
    JSON.stringify({ rejectTurnStarts: true }),
  );

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  const first = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'check the build',
  });

  const second = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'and the lint',
  });

  const read = await waitFor(async () => {
    const got = await ctx.daemon.client.sendRequest('message.get', { message: second['message'] });

    expect(got['status']).toBe('unanswered');

    return got;
  });

  const earlier = await ctx.daemon.client.sendRequest('message.get', { message: first['message'] });

  expect(read['unansweredReason']).toBe('error');
  expect(earlier['status']).toBe('unanswered');
});

test('it delivers a message to the thread a hook shows the terminal moved to and none to the old one', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.stubDir, 'app-server-scenario.json'),
    JSON.stringify({ reply: 'the lint is clean' }),
  );

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  // The terminal runs once the bridge has opened the session's thread.
  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('session.screen', { session: id });

    expect(JSON.stringify(read)).toInclude('FAKE_CODEX_UP');
  });

  const socket = join(ctx.daemon.directory, 'sessions', id, 'codex', 'codex.sock');

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'SessionStart',
    payload: { session_id: 'thread-1' },
  });

  const moved = await startCodexTerminalThread(socket);

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'SessionStart',
    payload: { session_id: moved },
  });

  await waitFor(async () => {
    const listed = await ctx.daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: moved });
  });

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'run the lint',
  });

  const answered = await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('message.get', { message: sent['message'] });

    expect(read['status']).toBe('answered');

    return read;
  });

  expect(answered['answer']).toBe('the lint is clean');

  expect(ctx.readRequests().filter((request) => request.method === 'turn/start')).toMatchObject([
    { params: { threadId: moved, clientUserMessageId: sent['message'] } },
  ]);
});

test('it keeps delivering to the thread the terminal moved to when a turn of the old thread ends later', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.stubDir, 'app-server-scenario.json'),
    JSON.stringify({ reply: 'the docs build' }),
  );

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  // The terminal runs once the bridge has opened the session's thread.
  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('session.screen', { session: id });

    expect(JSON.stringify(read)).toInclude('FAKE_CODEX_UP');
  });

  const socket = join(ctx.daemon.directory, 'sessions', id, 'codex', 'codex.sock');

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'SessionStart',
    payload: { session_id: 'thread-1' },
  });

  const moved = await startCodexTerminalThread(socket);

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'SessionStart',
    payload: { session_id: moved },
  });

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'Stop',
    payload: { session_id: 'thread-1', last_assistant_message: 'the old turn is done' },
  });

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'build the docs',
  });

  const answered = await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('message.get', { message: sent['message'] });

    expect(read['status']).toBe('answered');

    return read;
  });

  expect(answered['answer']).toBe('the docs build');

  expect(ctx.readRequests().filter((request) => request.method === 'turn/start')).toMatchObject([
    { params: { threadId: moved, clientUserMessageId: sent['message'] } },
  ]);

  const listed = await ctx.daemon.client.sendRequest('session.list');

  expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: moved });
});

test('it raises no attention for an approval a turn of the old thread asks for after the terminal moved', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  // The terminal runs once the bridge has opened the session's thread.
  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('session.screen', { session: id });

    expect(JSON.stringify(read)).toInclude('FAKE_CODEX_UP');
  });

  const socket = join(ctx.daemon.directory, 'sessions', id, 'codex', 'codex.sock');

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'SessionStart',
    payload: { session_id: 'thread-1' },
  });

  const moved = await startCodexTerminalThread(socket);

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'SessionStart',
    payload: { session_id: moved },
  });

  await ctx.daemon.sendHookLines(
    {
      atcId: id,
      event: 'PermissionRequest',
      payload: { session_id: 'thread-1', tool_name: 'shell' },
    },
    {
      atcId: id,
      event: 'Stop',
      payload: { session_id: 'thread-1', last_assistant_message: 'the old turn is done' },
    },
  );

  const listed = await ctx.daemon.client.sendRequest('session.list');

  expect(listed['sessions']).toPartiallyContain({
    id,
    agentSessionID: moved,
    state: 'running',
    lastMsg: 'started',
  });
});
