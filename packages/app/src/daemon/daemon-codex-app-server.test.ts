import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { CODEX_PLUGIN, CodexAdapter } from '@atc/harness-codex';
import {
  createStubAppServerCodex,
  getAgentEntry,
  getRecord,
  getString,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { startTestDaemon } from '../test-utils/start-test-daemon';

// A daemon whose one agent is a Codex entry on an App Server, run by the
// stand-in Codex CLI, which reads its scenario from the stub folder and
// logs every request it takes there.
async function setupTest() {
  const tmp = setupTempDir('atc-codex-app-server-');
  const bin = createStubAppServerCodex(tmp.dir);

  const codex = new CodexAdapter(
    getAgentEntry(
      parseConfig([CODEX_PLUGIN], { agents: { codex: { bin, appServer: true } } }),
      'codex',
    ),
  );

  const daemon = await startTestDaemon({ options: () => ({ adapter: codex }) });

  return {
    daemon,
    stubDir: tmp.dir,
    readRequests: () =>
      readFileSync(join(tmp.dir, 'app-server-requests.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line): { method: string; params: Record<string, unknown> } => JSON.parse(line)),
  };
}

test('it delivers a message to a Codex session through its App Server and stores the answer', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.stubDir, 'app-server-scenario.json'),
    JSON.stringify({ reply: 'the build passes' }),
  );

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
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
    cwd: ctx.daemon.dir,
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

  await waitFor(() =>
    expect(
      ctx.readRequests().filter((r) => r.method === 'thread/turns/list').length,
    ).toBeGreaterThan(1),
  );

  const first = await ctx.daemon.client.sendRequest('message.get', {
    message: accepted['message'],
  });

  const second = await ctx.daemon.client.sendRequest('message.get', { message: taken['message'] });

  expect(first['status']).toBe('delivered');
  expect(second['status']).toBe('queued');
  expect(ctx.readRequests().filter((r) => r.method === 'turn/start')).toHaveLength(2);
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
    cwd: ctx.daemon.dir,
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
  expect(ctx.readRequests().filter((r) => r.method === 'turn/start')).toHaveLength(1);
  expect(ctx.readRequests().map((r) => r.method)).toContain('thread/resume');
});

test('it starts the terminal against the session App Server on the bridge thread', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
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
