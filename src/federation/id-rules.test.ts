import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeTranscriptLine } from '../agents/parse-claude-transcript-line';
import { buildPayloadHash } from '../daemon/build-payload-hash';
import { REQUEST_PARAM_SCHEMAS } from '../protocol/request-param-schemas';
import { getRecord } from '../shared/get-record';
import { isRecord } from '../shared/report';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { collectUnruledIDPaths } from './collect-unruled-id-paths';
import { ERROR_DATA_RULES, ID_RULES } from './id-rules';

/**
 * A real daemon whose sessions run `sleep`. Every hook a session reports
 * starts it on `transcript.jsonl` in the daemon's directory, which
 * `session.read` then reads. Every answer these tests check comes from it,
 * so a field the daemon starts sending with an id in it fails the check
 * until a rule covers it.
 */
function setupTest() {
  return startTestDaemon({
    prefix: 'atc-id-rules-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter({
        // Session messages need an adapter that takes them.
        takesMessages: true,

        // Every hook starts the session on the transcript in the directory.
        normalizeHook: () => ({
          kind: 'started',
          transcriptSource: join(paths.dir, 'transcript.jsonl'),
        }),

        // A resume command that holds the agent's session id.
        buildResumeCommand: (_cwd, agentSessionID) => `claude --resume ${agentSessionID ?? ''}`,
        parseTranscriptLine: parseClaudeTranscriptLine,
      }),
    }),
  });
}

test('it has a rule for every id in a session.spawn answer of a sub-session', async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    resume: `a-${randomUUID()}`,
  });

  const child = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    resume: `a-${randomUUID()}`,
    parent: getRecord(parent, 'session')['id'],
  });

  expect(collectUnruledIDPaths(child, ID_RULES['session.spawn'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in a session.list answer', async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    resume: `a-${randomUUID()}`,
  });

  await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    resume: `a-${randomUUID()}`,
    parent: getRecord(parent, 'session')['id'],
  });

  const listed = await ctx.client.sendRequest('session.list');

  expect(collectUnruledIDPaths(listed, ID_RULES['session.list'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in a session.get answer', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    resume: `a-${randomUUID()}`,
    prompt: 'hello',
  });

  const got = await ctx.client.sendRequest('session.get', {
    session: getRecord(spawned, 'session')['id'],
  });

  expect(collectUnruledIDPaths(got, ID_RULES['session.get'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in a session.message answer', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    resume: `a-${randomUUID()}`,
  });

  const sent = await ctx.client.sendRequest('session.message', {
    session: getRecord(spawned, 'session')['id'],
    from: 'tester',
    text: 'ping',
    idempotencyKey: 'message-1',
  });

  expect(collectUnruledIDPaths(sent, ID_RULES['session.message'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in a message.get answer', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    resume: `a-${randomUUID()}`,
  });

  const sent = await ctx.client.sendRequest('session.message', {
    session: getRecord(spawned, 'session')['id'],
    from: 'tester',
    text: 'ping',
    idempotencyKey: 'message-1',
  });

  const got = await ctx.client.sendRequest('message.get', { message: sent['message'] });

  expect(collectUnruledIDPaths(got, ID_RULES['message.get'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in an events.read answer', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    resume: `a-${randomUUID()}`,
  });

  await ctx.client.sendRequest('session.message', {
    session: getRecord(spawned, 'session')['id'],
    from: 'tester',
    text: 'ping',
  });

  const read = await waitFor(async () => {
    const page = await ctx.client.sendRequest('events.read', {});

    expect(page['events']).toBeArray();
    expect(page['events']).not.toBeEmpty();

    return page;
  });

  expect(collectUnruledIDPaths(read, ID_RULES['events.read'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in the data of an uncertain keyed spawn', async () => {
  await using ctx = await setupTest();

  const params = { cwd: ctx.dir, resume: 'a-1', idempotencyKey: 'spawn-1' };
  const effectRef = randomUUID();

  const seed = await StateStore.open(ctx.dbPath);

  onTestFinished(() => seed.stop());

  // A claim still in progress under the key, which the daemon answers as
  // an interrupted spawn whose effect may stand.
  await seed.claimIdempotencyKey({
    principal: 'local',
    operation: 'session.spawn',
    key: 'spawn-1',
    payloadHash: buildPayloadHash(REQUEST_PARAM_SCHEMAS['session.spawn'].parse(params)),
    effectRef,
    at: Date.now(),
  });

  const spawned = ctx.client.sendRequest('session.spawn', params);

  expect(spawned).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(spawned).rejects.toHaveProperty('data', { effectRef });
  expect(collectUnruledIDPaths({ effectRef }, ERROR_DATA_RULES)).toStrictEqual([]);
});

test('it has a rule for every id in a session.read answer, transcript text included', async () => {
  await using ctx = await setupTest();

  const agentSessionID = randomUUID();

  writeFileSync(
    join(ctx.dir, 'transcript.jsonl'),
    `${JSON.stringify({ type: 'user', sessionId: agentSessionID, message: { content: `resume ${agentSessionID}` } })}\n`,
  );

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    resume: `a-${randomUUID()}`,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.sendHookLines({ atcId: id, event: 'SessionStart', payload: {} });

  const read = await waitFor(async () => {
    const page = await ctx.client.sendRequest('session.read', { session: id });

    expect(page['rows']).toBeArray();
    expect(page['rows']).not.toBeEmpty();

    return page;
  });

  expect(collectUnruledIDPaths(read, ID_RULES['session.read'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in a session.resumeCommand answer', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    resume: randomUUID(),
  });

  const command = await ctx.client.sendRequest('session.resumeCommand', {
    session: getRecord(spawned, 'session')['id'],
  });

  expect(command['command']).toMatch(/[\da-f]{8}-/);

  expect(
    collectUnruledIDPaths(command, ID_RULES['session.resumeCommand'] ?? new Map()),
  ).toStrictEqual([]);
});

test('it has a rule for every id in an agents.list answer', async () => {
  await using ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, resume: `a-${randomUUID()}` });

  const agents = await ctx.client.sendRequest('agents.list');

  expect(collectUnruledIDPaths(agents, ID_RULES['agents.list'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in a dirs.list answer', async () => {
  await using ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, resume: `a-${randomUUID()}` });

  const dirs = await ctx.client.sendRequest('dirs.list');

  expect(collectUnruledIDPaths(dirs, ID_RULES['dirs.list'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in a report.get answer', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    resume: `a-${randomUUID()}`,
  });

  await ctx.sendHookLines({
    atcId: getRecord(spawned, 'session')['id'],
    event: 'Report',
    payload: { kind: 'note', label: 'decision', text: 'done' },
  });

  const event = await waitFor(async () => {
    const page = await ctx.client.sendRequest('events.read', {});

    const found = [page['events']].flat().find((e) => isRecord(e) && e['kind'] === 'report');

    if (!isRecord(found)) {
      throw new TypeError('no report event yet');
    }

    return found;
  });

  const report = await ctx.client.sendRequest('report.get', { report: event['cursor'] });

  expect(collectUnruledIDPaths(report, ID_RULES['report.get'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for the confirm token in a session.forget answer', () => {
  expect(
    collectUnruledIDPaths(
      { confirmToken: randomUUID(), expiresAt: Date.now() + 60_000 },
      ID_RULES['session.forget'] ?? new Map(),
    ),
  ).toStrictEqual([]);
});
