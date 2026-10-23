import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@atc/core';
import { buildPayloadHash } from '@atc/daemon';
import { ERROR_DATA_RULES, ID_RULES, collectUnruledIDPaths } from '@atc/gateway';
import { parseClaudeTranscriptLine } from '@atc/harness-claude';
import { createStateStore } from '@atc/store';
import { buildMockAgentAdapter, getRecord, registerTestCleanup, waitFor } from '@atc/test-utils';
import { REQUEST_PARAM_SCHEMAS } from '@atcx/contract';
import invariant from 'tiny-invariant';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

async function setupTest() {
  // under `/tmp`, not the temp root: a session's temp root holds its session id, and a path
  // with an id in it fails the check
  const cwd = mkdtempSync('/tmp/atc-id-rules-cwd-');

  registerTestCleanup(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-id-rules-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        // Session messages need an adapter that takes them.
        takesMessages: true,
        parseTranscriptLine: parseClaudeTranscriptLine,
      }),
    }),
  });

  return Object.assign(daemon, { cwd });
}

test('it has a rule for every id in a session.spawn answer of a sub-session', async () => {
  const ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    resume: `a-${randomUUID()}`,
  });

  const child = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    resume: `a-${randomUUID()}`,
    parent: getRecord(parent, 'session')['id'],
  });

  expect(collectUnruledIDPaths(child, ID_RULES['session.spawn'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in a session.list answer', async () => {
  const ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    resume: `a-${randomUUID()}`,
  });

  await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    resume: `a-${randomUUID()}`,
    parent: getRecord(parent, 'session')['id'],
  });

  const listed = await ctx.client.sendRequest('session.list');

  expect(collectUnruledIDPaths(listed, ID_RULES['session.list'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in a session.get answer', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    resume: `a-${randomUUID()}`,
    prompt: 'hello',
  });

  const got = await ctx.client.sendRequest('session.get', {
    session: getRecord(spawned, 'session')['id'],
  });

  expect(collectUnruledIDPaths(got, ID_RULES['session.get'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in a session.scope.add answer', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    resume: `a-${randomUUID()}`,
  });

  const added = await ctx.client.sendRequest('session.scope.add', {
    session: getRecord(spawned, 'session')['id'],
    scope: {},
  });

  expect(collectUnruledIDPaths(added, ID_RULES['session.scope.add'] ?? new Map())).toStrictEqual(
    [],
  );

  expect(ID_RULES['session.scope.add']).toBeDefined();
});

test('it has a rule for every id in a session.message answer', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    resume: `a-${randomUUID()}`,
  });

  const sent = await ctx.client.sendRequest('session.message', {
    session: getRecord(spawned, 'session')['id'],
    text: 'ping',
    idempotencyKey: 'message-1',
  });

  expect(collectUnruledIDPaths(sent, ID_RULES['session.message'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in a message.get answer', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    resume: `a-${randomUUID()}`,
  });

  const sessionID = getRecord(spawned, 'session')['id'];

  // A message a session sends holds that session's id in its sender.
  const inside = await ctx.openClient({ session: sessionID });

  const sent = await inside.sendRequest('session.message', {
    session: sessionID,
    text: 'ping',
    idempotencyKey: 'message-1',
  });

  const got = await ctx.client.sendRequest('message.get', { message: sent['message'] });

  expect(getRecord(got, 'sender')['kind']).toBe('session');
  expect(collectUnruledIDPaths(got, ID_RULES['message.get'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in an events.read answer', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    resume: `a-${randomUUID()}`,
  });

  await ctx.client.sendRequest('session.message', {
    session: getRecord(spawned, 'session')['id'],
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
  const ctx = await setupTest();

  const params = { cwd: ctx.cwd, resume: 'a-1', idempotencyKey: 'spawn-1' };
  const effectRef = randomUUID();

  const seed = await createStateStore(ctx.dbPath);

  registerTestCleanup(() => seed.stop());

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

  expect(spawned).rejects.toThrow(
    expect.objectContaining({ code: 'outcome_unknown', data: { effectRef } }),
  );

  expect(collectUnruledIDPaths({ effectRef }, ERROR_DATA_RULES)).toStrictEqual([]);
});

test('it has a rule for every id in a session.read answer, transcript text included', async () => {
  const ctx = await startTestDaemon({
    prefix: 'atc-id-rules-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        parseTranscriptLine: parseClaudeTranscriptLine,

        // Every hook starts the session on the transcript in the directory.
        planHookEvents: () => ({
          events: [
            { kind: 'started', transcriptSource: join(paths.directory, 'transcript.jsonl') },
          ],
        }),
      }),
    }),
  });

  const agentSessionID = randomUUID();

  writeFileSync(
    join(ctx.directory, 'transcript.jsonl'),
    `${JSON.stringify({ type: 'user', sessionId: agentSessionID, message: { content: `resume ${agentSessionID}` } })}\n`,
  );

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
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
  const ctx = await startTestDaemon({
    prefix: 'atc-id-rules-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        parseTranscriptLine: parseClaudeTranscriptLine,

        // A resume command that holds the agent's session id.
        planResumeCommand: (_cwd, agentSessionID) => `claude --resume ${agentSessionID ?? ''}`,
      }),
    }),
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    resume: randomUUID(),
  });

  const command = await ctx.client.sendRequest('session.resumeCommand', {
    session: getRecord(spawned, 'session')['id'],
  });

  expect(command['command']).toMatch(/[\da-f]{8}-/u);

  expect(
    collectUnruledIDPaths(command, ID_RULES['session.resumeCommand'] ?? new Map()),
  ).toStrictEqual([]);
});

test('it has a rule for every id in an agents.list answer', async () => {
  const ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', { cwd: ctx.cwd, resume: `a-${randomUUID()}` });

  const agents = await ctx.client.sendRequest('agents.list');

  expect(collectUnruledIDPaths(agents, ID_RULES['agents.list'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in a dirs.list answer', async () => {
  const ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', { cwd: ctx.cwd, resume: `a-${randomUUID()}` });

  const dirs = await ctx.client.sendRequest('dirs.list');

  expect(collectUnruledIDPaths(dirs, ID_RULES['dirs.list'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in a note.get answer', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    resume: `a-${randomUUID()}`,
  });

  await ctx.sendHookLines({
    atcId: getRecord(spawned, 'session')['id'],
    event: 'Note',
    payload: { kind: 'note', label: 'decision', text: 'done' },
  });

  const event = await waitFor(async () => {
    const page = await ctx.client.sendRequest('events.read', {});

    const found = [page['events']]
      .flat()
      .find((feedEvent) => isRecord(feedEvent) && feedEvent['kind'] === 'note');

    invariant(isRecord(found), 'no note event yet');

    return found;
  });

  const note = await ctx.client.sendRequest('note.get', { note: event['cursor'] });

  expect(collectUnruledIDPaths(note, ID_RULES['note.get'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for every id in an answer.get answer', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    resume: `a-${randomUUID()}`,
  });

  const sessionID = getRecord(spawned, 'session')['id'];

  const sent = await ctx.client.sendRequest('session.message', {
    session: sessionID,
    text: 'ping',
  });

  await ctx.sendHookLines({
    atcId: sessionID,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer: 'pong' },
  });

  const event = await waitFor(async () => {
    const page = await ctx.client.sendRequest('events.read', {});

    const found = [page['events']]
      .flat()
      .find((feedEvent) => isRecord(feedEvent) && feedEvent['kind'] === 'message-answered');

    invariant(isRecord(found), 'no answered event yet');

    return found;
  });

  const answer = await ctx.client.sendRequest('answer.get', { answer: event['cursor'] });

  expect(collectUnruledIDPaths(answer, ID_RULES['answer.get'] ?? new Map())).toStrictEqual([]);
});

test('it has a rule for the confirm token in a session.forget answer', () => {
  expect(
    collectUnruledIDPaths(
      { confirmToken: randomUUID(), expiresAt: Date.now() + 60_000 },
      ID_RULES['session.forget'] ?? new Map(),
    ),
  ).toStrictEqual([]);
});
