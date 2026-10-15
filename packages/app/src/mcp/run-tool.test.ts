import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@atc/core/is-record';
import { toSessionID } from '@atc/core/to-session-id';
import { DaemonClient } from '@atc/protocol/client/daemon-client';
import { DAEMON_FEATURES } from '@atc/protocol/daemon-features';
import { REQUEST_PARAM_SCHEMAS } from '@atc/protocol/request-param-schemas';
import { StateStore } from '@atc/store/state-store';
import { buildMockAgentAdapter } from '@atc/test-utils/build-mock-agent-adapter';
import { getRecord } from '@atc/test-utils/get-record';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { spawnNamedSession } from '@atc/test-utils/spawn-named-session';
import { startStubLegacyDaemon } from '@atc/test-utils/start-stub-legacy-daemon';
import { waitFor } from '@atc/test-utils/wait-for';
import { $ } from 'bun';
import invariant from 'tiny-invariant';
import { buildPayloadHash } from '../daemon/build-payload-hash';
import { buildStubFleetCaller } from '../test-utils/build-stub-fleet-caller';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { ReconnectingCaller } from './reconnecting-caller';
import { runTool } from './run-tool';

// A real daemon whose sessions run `sleep`, and `atc mcp`'s caller in front
// of it, which connects on its first request.
async function setupTest() {
  const daemon = await startTestDaemon({
    prefix: 'atc-run-tool-',
    options: () => ({ adapter: buildMockAgentAdapter() }),
  });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  return { caller, dir: daemon.dir };
}

test('it sends no sender of the call to the daemon, which labels the message itself', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ message: 'm1' }) });

  await runTool(
    caller,
    'atc_message_send',
    { session: 's1', text: 'hello', from: 'impostor' },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.message',
      p: { session: 's1', text: 'hello' },
      required: ['vocabulary.note', 'message.unanswered', 'message.sender'],
    },
  ]);
});

test('it requires answer notices from the daemon for a send from inside a session', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ message: 'm1' }) });

  await runTool(
    caller,
    'atc_message_send',
    { session: 's1', text: 'hello' },
    { callerSessionID: 's-sender' },
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.message',
      p: { session: 's1', text: 'hello' },
      required: ['vocabulary.note', 'message.unanswered', 'message.sender', 'message.notice'],
    },
  ]);
});

test('it forwards a message wait to the daemon', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ message: 'm1', status: 'delivered' }) });

  await runTool(
    caller,
    'atc_message_get',
    { message: 'm1', waitMs: 20_000 },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'message.get',
      p: { message: 'm1', waitMs: 20_000 },
      required: ['vocabulary.note', 'message.unanswered', 'message.wait'],
    },
  ]);
});

test('it forwards an events session filter to the daemon', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ events: [], cursor: 'c', more: false }) });

  await runTool(
    caller,
    'atc_events_read',
    { session: 's1', waitMs: 1000 },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'events.read',
      p: { waitMs: 1000, session: 's1' },
      required: ['vocabulary.note', 'events.session', 'note.get'],
    },
  ]);
});

const NOTE_PAGE: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'events.read': {
    events: [
      { cursor: 'c1', at: 1, session: 's1', name: null, kind: 'note', detail: 'hi', label: 'l' },
      { cursor: 'c2', at: 2, session: 's1', name: null, kind: 'turn-done', detail: null },
    ],
    cursor: 'c2',
    more: false,
  },
  'note.get': { text: 'hi there', complete: true },
};

test('it reads the whole text of each note of an events page by default', async () => {
  const caller = buildStubFleetCaller({ answer: (request) => NOTE_PAGE[request.m] ?? {} });

  const read = await runTool(
    caller,
    'atc_events_read',
    { cursor: 'c0' },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    { m: 'events.read', p: { cursor: 'c0' }, required: ['vocabulary.note', 'note.get'] },
    { m: 'note.get', p: { note: 'c1' }, required: ['note.get'] },
  ]);

  expect(read.structured).toStrictEqual({
    events: [
      {
        cursor: 'c1',
        at: 1,
        session: 's1',
        name: null,
        kind: 'note',
        detail: 'hi',
        label: 'l',
        text: 'hi there',
        complete: true,
      },
      { cursor: 'c2', at: 2, session: 's1', name: null, kind: 'turn-done', detail: null },
    ],
    cursor: 'c2',
    more: false,
  });
});

test('it returns the note previews as the events carry them when the call asks for previews only', async () => {
  const caller = buildStubFleetCaller({ answer: (request) => NOTE_PAGE[request.m] ?? {} });

  const read = await runTool(
    caller,
    'atc_events_read',
    { previewOnly: true },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    { m: 'events.read', p: {}, required: ['vocabulary.note'] },
  ]);

  expect(read.structured).toMatchObject({
    events: [
      { cursor: 'c1', kind: 'note', detail: 'hi', label: 'l' },
      { cursor: 'c2', kind: 'turn-done' },
    ],
  });

  expect(read.structured?.['events']).not.toContainEqual(
    expect.objectContaining({ text: 'hi there' }),
  );
});

test.each([[{}], [{ previewOnly: true }]])(
  'it strips the note handle from every event when the call is %j',
  async (args) => {
    const caller = buildStubFleetCaller({
      answer: (request) =>
        request.m === 'events.read'
          ? {
              events: [
                {
                  cursor: 'c1',
                  at: 1,
                  session: 's1',
                  name: null,
                  kind: 'note',
                  detail: 'hi',
                  label: 'l',
                  note: 'handle-1',
                },
              ],
              cursor: 'c1',
              more: false,
            }
          : { text: 'hi there', complete: true },
    });

    const read = await runTool(caller, 'atc_events_read', args, {
      callerSessionID: null,
    });

    expect(JSON.stringify(read.structured)).not.toInclude('handle-1');
    expect(read.text).not.toInclude('handle-1');
  },
);

test('it reads a note by the handle of its event before stripping it', async () => {
  const caller = buildStubFleetCaller({
    answer: (request) =>
      request.m === 'events.read'
        ? {
            events: [
              {
                cursor: 'c1',
                at: 1,
                session: 's1',
                name: null,
                kind: 'note',
                detail: 'hi',
                note: 'h1',
              },
            ],
            cursor: 'c1',
            more: false,
          }
        : { text: 'hi there', complete: true },
  });

  await runTool(caller, 'atc_events_read', {}, { callerSessionID: null });

  expect(caller.requests.at(-1)).toStrictEqual({
    m: 'note.get',
    p: { note: 'h1' },
    required: ['note.get'],
  });
});

test("it returns a message's whole answer on its answered event by default", async () => {
  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const id = await spawnNamedSession((m, p) => daemon.client.sendRequest(m, p), 'one', daemon.dir);

  const answer = 'The importer skips empty rows. '.repeat(40);

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'does the importer skip empty rows?',
  });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer },
  });

  const read = await waitFor(async () => {
    const tool = await runTool(caller, 'atc_events_read', {}, { callerSessionID: null });

    expect(JSON.stringify(tool.structured)).toInclude('message-answered');

    return tool;
  });

  expect(read.structured?.['events']).toPartiallyContain({
    kind: 'message-answered',
    message: sent['message'],
    detail: `${answer.slice(0, 599)}…`,
    text: answer,
    complete: true,
  });
});

test('it returns the answer preview on an answered event when the call asks for previews only', async () => {
  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const id = await spawnNamedSession((m, p) => daemon.client.sendRequest(m, p), 'one', daemon.dir);

  const answer = 'The importer skips empty rows. '.repeat(40);

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'does the importer skip empty rows?',
  });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer },
  });

  const read = await waitFor(async () => {
    const tool = await runTool(
      caller,
      'atc_events_read',
      { previewOnly: true },
      { callerSessionID: null },
    );

    expect(JSON.stringify(tool.structured)).toInclude('message-answered');

    return tool;
  });

  const events = read.structured?.['events'];

  invariant(Array.isArray(events), 'no events');

  const answered: unknown = events.find(
    (e: unknown) => isRecord(e) && e['kind'] === 'message-answered',
  );

  expect(answered).toStrictEqual({
    cursor: expect.any(String),
    at: expect.any(Number),
    session: id,
    name: 'one',
    kind: 'message-answered',
    message: sent['message'],
    detail: `${answer.slice(0, 599)}…`,
  });
});

test('it reads an answer by the handle of its event and strips the handle', async () => {
  const caller = buildStubFleetCaller({
    answer: (request) =>
      request.m === 'events.read'
        ? {
            events: [
              {
                cursor: 'c1',
                at: 1,
                session: 's1',
                name: null,
                kind: 'message-answered',
                message: 'm-1',
                detail: 'yes',
                answer: 'handle-1',
              },
            ],
            cursor: 'c1',
            more: false,
          }
        : { text: 'yes, every row', complete: true },
  });

  const read = await runTool(caller, 'atc_events_read', {}, { callerSessionID: null });

  expect(caller.requests.at(-1)).toStrictEqual({
    m: 'answer.get',
    p: { answer: 'handle-1' },
    required: ['answer.get'],
  });

  expect(read.structured).toStrictEqual({
    events: [
      {
        cursor: 'c1',
        at: 1,
        session: 's1',
        name: null,
        kind: 'message-answered',
        message: 'm-1',
        detail: 'yes',
        text: 'yes, every row',
        complete: true,
      },
    ],
    cursor: 'c1',
    more: false,
  });
});

test('it sends a message under the key the call gives and needs a daemon that takes keys', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ message: 'm1' }) });

  await runTool(
    caller,
    'atc_message_send',
    { session: 's1', text: 'hello', idempotencyKey: 'k-1' },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.message',
      p: { session: 's1', text: 'hello', idempotencyKey: 'k-1' },
      required: ['vocabulary.note', 'message.unanswered', 'message.sender', 'message.idempotency'],
    },
  ]);
});

test("it passes a keyed send's from on to the daemon from local atc mcp, for legacy key matches alone", async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ message: 'm1' }) });

  await runTool(
    caller,
    'atc_message_send',
    { session: 's1', text: 'hello', from: 'release-bot', idempotencyKey: 'k-1' },
    { callerSessionID: null, passesLegacyFrom: true },
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.message',
      p: { session: 's1', text: 'hello', idempotencyKey: 'k-1', from: 'release-bot' },
      required: ['vocabulary.note', 'message.unanswered', 'message.sender', 'message.idempotency'],
    },
  ]);
});

test.each([
  ['an unkeyed send from local atc mcp', { callerSessionID: null, passesLegacyFrom: true }, {}],
  ['a keyed send from a remote caller', { callerSessionID: null }, { idempotencyKey: 'k-1' }],
] as const)('it passes no from on to the daemon for %s', async (_case, ctx, keyed) => {
  const caller = buildStubFleetCaller({ answer: () => ({ message: 'm1' }) });

  await runTool(
    caller,
    'atc_message_send',
    { session: 's1', text: 'hello', from: 'release-bot', ...keyed },
    ctx,
  );

  expect(caller.requests.map((request) => request.p)).toStrictEqual([
    { session: 's1', text: 'hello', ...keyed },
  ]);
});

test('it replays a message key an older atc mcp stored with a given from, and labels each message by its caller', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-run-tool-',
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const session = getRecord(spawned, 'session')['id'];
  const local = { callerSessionID: null, passesLegacyFrom: true };

  const first = await runTool(
    caller,
    'atc_message_send',
    { session, text: 'check the tide tables', idempotencyKey: 'k-first' },
    local,
  );

  const message = first.structured?.['message'];

  // The key an older atc mcp left for the same send with from release-bot.
  // The daemon reads the ledger from the database on each keyed request, so
  // a key written beside the running daemon is one it holds.
  const seed = await StateStore.open(daemon.dbPath);

  const stopSeed = registerTestCleanup(() => seed.stop());
  const id = { principal: 'local', operation: 'session.message', key: 'k-tide' };

  await seed.claimIdempotencyKey({
    ...id,
    payloadHash: buildPayloadHash({ session, text: 'check the tide tables', from: 'release-bot' }),
    effectRef: String(message),
    at: Date.now(),
  });

  await seed.updateIdempotencyCompleted(
    id,
    JSON.stringify({ message, status: 'queued' }),
    Date.now(),
    null,
  );

  await stopSeed();

  const retry = {
    session,
    text: 'check the tide tables',
    from: 'release-bot',
    idempotencyKey: 'k-tide',
  };

  const remote = runTool(caller, 'atc_message_send', retry, { callerSessionID: null });

  await Promise.allSettled([remote]);

  const replayed = await runTool(caller, 'atc_message_send', retry, local);

  const fresh = await runTool(
    caller,
    'atc_message_send',
    { ...retry, idempotencyKey: 'k-fresh' },
    local,
  );

  const senders = await Promise.all(
    [message, fresh.structured?.['message']].map(async (sent) => {
      const got = await runTool(caller, 'atc_message_get', { message: sent }, local);

      return [got.structured?.['from'], got.structured?.['sender']];
    }),
  );

  expect(remote).rejects.toMatchObject({ code: 'idempotency_conflict' });
  expect(replayed.structured).toStrictEqual({ message, status: 'queued' });
  expect(fresh.structured?.['message']).not.toBe(message);

  expect(senders).toStrictEqual([
    ['owner', { kind: 'owner', name: 'owner' }],
    ['owner', { kind: 'owner', name: 'owner' }],
  ]);
});

test('it spawns top-level under a key of its own when the calling session is gone', async () => {
  const ctx = await setupTest();

  const relay = buildStubFleetCaller({
    answer: (request) =>
      ctx.caller.sendRequest(request.m, request.p, request.required, request.principal),
  });

  await runTool(
    relay,
    'atc_session_spawn',
    { cwd: ctx.dir, idempotencyKey: 'k-1' },
    { callerSessionID: 'gone' },
  );

  expect(relay.requests).toStrictEqual([
    {
      m: 'session.spawn',
      p: { cwd: ctx.dir, idempotencyKey: 'k-1', cols: 100, rows: 30, parent: 'gone' },
      required: ['spawn.idempotency'],
    },
    {
      m: 'session.spawn',
      p: {
        cwd: ctx.dir,
        idempotencyKey:
          'top-level:7c35c5a1785d20704e44d5de4beb81c1fce91b6fe48ed7c3159af6f7f832078b',
        cols: 100,
        rows: 30,
      },
      required: ['spawn.idempotency'],
    },
  ]);
});

test('it spawns nothing top-level when the gone session belongs to a spawn its key already ran', async () => {
  // The key's spawn ran before a restart and created a session the fleet
  // holds but has not restored, so the daemon refuses the retried spawn with
  // that session's id and starts nothing.
  const daemon = await startTestDaemon({
    prefix: 'atc-run-tool-',
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      const stopSeed = registerTestCleanup(() => seed.stop());

      await seed.claimIdempotencyKey({
        principal: 'local',
        operation: 'session.spawn',
        key: 'k-1',
        payloadHash: buildPayloadHash(
          REQUEST_PARAM_SCHEMAS['session.spawn'].parse({
            cwd: paths.dir,
            idempotencyKey: 'k-1',
            cols: 100,
            rows: 30,
            parent: 'parent',
          }),
        ),
        effectRef: 'spawned-before-restart',
        at: Date.now(),
      });

      await seed.writeFleet([
        {
          sessionID: toSessionID('spawned-before-restart'),
          name: 'tmp',
          cwd: paths.dir,
          agent: 'claude',
          exited: true,
        },
      ]);

      await stopSeed();

      return { adapter: buildMockAgentAdapter() };
    },
  });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const relay = buildStubFleetCaller({
    answer: (request) =>
      caller.sendRequest(request.m, request.p, request.required, request.principal),
  });

  const call = runTool(
    relay,
    'atc_session_spawn',
    { cwd: daemon.dir, idempotencyKey: 'k-1' },
    { callerSessionID: 'parent' },
  );

  expect(call).rejects.toMatchObject({
    code: 'no_such_session',
    data: { effectRef: 'spawned-before-restart' },
  });

  expect(relay.requests).toStrictEqual([
    {
      m: 'session.spawn',
      p: { cwd: daemon.dir, idempotencyKey: 'k-1', cols: 100, rows: 30, parent: 'parent' },
      required: ['spawn.idempotency'],
    },
  ]);
});

test('it derives a top-level fallback key within the daemon cap from the longest key a call may pass', async () => {
  const ctx = await setupTest();

  const relay = buildStubFleetCaller({
    answer: (request) =>
      ctx.caller.sendRequest(request.m, request.p, request.required, request.principal),
  });

  await runTool(
    relay,
    'atc_session_spawn',
    { cwd: ctx.dir, idempotencyKey: 'k'.repeat(180) },
    { callerSessionID: 'gone' },
  );

  expect(relay.requests.map((request) => request.p?.['idempotencyKey'])).toStrictEqual([
    'k'.repeat(180),
    expect.stringMatching(/^top-level:[0-9a-f]{64}$/),
  ]);
});

test('it derives the same top-level fallback key when the call is retried', async () => {
  const ctx = await setupTest();

  const relay = buildStubFleetCaller({
    answer: (request) =>
      ctx.caller.sendRequest(request.m, request.p, request.required, request.principal),
  });

  await runTool(
    relay,
    'atc_session_spawn',
    { cwd: ctx.dir, idempotencyKey: 'k'.repeat(180) },
    { callerSessionID: 'gone' },
  );

  await runTool(
    relay,
    'atc_session_spawn',
    { cwd: ctx.dir, idempotencyKey: 'k'.repeat(180) },
    { callerSessionID: 'gone' },
  );

  const keys = relay.requests.map((request) => request.p?.['idempotencyKey']);

  expect(keys).toStrictEqual([
    'k'.repeat(180),
    expect.stringMatching(/^top-level:[0-9a-f]{64}$/),
    'k'.repeat(180),
    keys[1],
  ]);
});

test('it refuses a spawn key longer than 180 characters as bad_args and sends nothing', () => {
  const caller = buildStubFleetCaller({ answer: () => ({ session: { id: 's-1' } }) });

  const call = runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp', idempotencyKey: 'k'.repeat(181) },
    { callerSessionID: null },
  );

  expect(call).rejects.toMatchObject({ code: 'bad_args' });
  expect(caller.requests).toStrictEqual([]);
});

test('it refuses a message key longer than 180 characters as bad_args and sends nothing', () => {
  const caller = buildStubFleetCaller({ answer: () => ({ message: 'm1' }) });

  const call = runTool(
    caller,
    'atc_message_send',
    { session: 's1', text: 'hello', idempotencyKey: 'k'.repeat(181) },
    { callerSessionID: null },
  );

  expect(call).rejects.toMatchObject({ code: 'bad_args' });
  expect(caller.requests).toStrictEqual([]);
});

test('it spawns on the target the call gives and needs a daemon that takes targets', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ session: { id: 's-1' } }) });

  await runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp', target: 'box' },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.spawn',
      p: { cwd: '/tmp', target: 'box', cols: 100, rows: 30 },
      required: ['spawn.target'],
    },
  ]);
});

test('it refuses a spawn on a target unsent when the daemon predates targets', () => {
  const tmp = setupTempDir('atc-run-tool-');

  const legacy = startStubLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: ['agents.list', 'events.more', 'events.session', 'message.turn', 'message.wait'],
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const spawn = runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp', target: 'box' },
    { callerSessionID: null },
  );

  expect(spawn).rejects.toThrow(/^daemon_outdated: .*atc_session_spawn's target/);
  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it spawns with the workspace the call gives and needs a daemon that takes workspaces', async () => {
  const workspace = { kind: 'git', url: 'https://example.com/r.git', ref: 'main' };
  const caller = buildStubFleetCaller({ answer: () => ({ session: { id: 's-1' } }) });

  await runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp/ws', workspace },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.spawn',
      p: { cwd: '/tmp/ws', workspace, cols: 100, rows: 30 },
      required: ['spawn.workspace'],
    },
  ]);
});

test('it spawns a git workspace without a cwd and returns the directory the daemon picked under the home', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-run-tool-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['file'],
      homeDir: join(paths.dir, 'home'),
    }),
  });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const home = join(daemon.dir, 'home');
  const upstream = join(daemon.dir, 'upstream.git');
  const work = join(daemon.dir, 'work');

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };

  await $`git init --quiet --bare --template= --initial-branch=main ${upstream}`.env(env).quiet();
  await $`git clone --quiet --template= ${upstream} ${work}`.env(env).quiet();

  await $`git -c user.name=atc -c user.email=atc@example.com -c commit.gpgsign=false commit --quiet --allow-empty -m initial`
    .env(env)
    .cwd(work)
    .quiet();

  await $`git push --quiet origin main`.env(env).cwd(work).quiet();

  const result = await runTool(
    caller,
    'atc_session_spawn',
    { workspace: { kind: 'git', url: upstream, ref: 'main' } },
    { callerSessionID: null },
  );

  expect(result.structured).toMatchObject({
    cwd: join(home, '.local/share/atc/workspaces/upstream-main'),
    workspace: { repoURL: upstream, ref: 'main' },
  });

  expect(existsSync(join(home, '.local/share/atc/workspaces/upstream-main', '.git'))).toBeTrue();
});

test('it refuses a git workspace without a cwd unsent when the daemon predates picking its directory', () => {
  const tmp = setupTempDir('atc-run-tool-');

  const legacy = startStubLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: DAEMON_FEATURES.filter((feature) => feature !== 'spawn.workspace.autoDir'),
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const spawn = runTool(
    caller,
    'atc_session_spawn',
    { workspace: { kind: 'git', url: 'https://example.com/r.git', ref: 'main' } },
    { callerSessionID: null },
  );

  expect(spawn).rejects.toThrow(
    /^daemon_outdated: .*atc_session_spawn's git workspace without a cwd/,
  );

  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it returns the warnings a workspace spawn left with the session', async () => {
  const caller = buildStubFleetCaller({
    answer: () => ({ session: { id: 's-1' }, warnings: ['changes stay behind'] }),
  });

  const result = await runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp/ws', workspace: { kind: 'path', path: '/src/repo', allowDirty: 'warn' } },
    { callerSessionID: null },
  );

  expect(result.structured).toStrictEqual({ id: 's-1', warnings: ['changes stay behind'] });
});

test('it refuses a spawn with a workspace unsent when the daemon predates workspaces', () => {
  const tmp = setupTempDir('atc-run-tool-');

  const legacy = startStubLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: ['agents.list', 'events.more', 'events.session', 'message.turn', 'message.wait'],
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const spawn = runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp/ws', workspace: { kind: 'path', path: '/src/repo' } },
    { callerSessionID: null },
  );

  expect(spawn).rejects.toThrow(/^daemon_outdated: .*atc_session_spawn's workspace/);
  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it submits a session input line and needs a daemon that submits lines', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({}) });

  await runTool(
    caller,
    'atc_terminal_type',
    { session: 's1', text: 'hello' },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    { m: 'session.submit', p: { session: 's1', text: 'hello' }, required: ['session.submit'] },
  ]);
});

test('it refuses a session input line unsent when the daemon predates line submission', () => {
  const tmp = setupTempDir('atc-run-tool-');

  const legacy = startStubLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: DAEMON_FEATURES.filter((feature) => feature !== 'session.submit'),
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const input = runTool(
    caller,
    'atc_terminal_type',
    { session: 's1', text: 'hello' },
    { callerSessionID: null },
  );

  expect(input).rejects.toThrow(/^daemon_outdated: .*atc_terminal_type/);
  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it answers a typed line with the written flag', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({}) });

  const result = await runTool(
    caller,
    'atc_terminal_type',
    { session: 's1', text: 'hello' },
    { callerSessionID: null },
  );

  expect(result.structured).toStrictEqual({ written: true });
  expect(JSON.parse(result.text)).toStrictEqual({ written: true });
});

test('it reads the menu of a session when a choice call holds no menu token', async () => {
  const menu = {
    text: 'Do you want to proceed?',
    options: [
      { option: 1, label: 'Yes', checked: null, highlighted: true },
      { option: 2, label: 'No', checked: null, highlighted: false },
    ],
    menuToken: 'menu-of-the-test',
  };

  const caller = buildStubFleetCaller({ answer: () => ({ menu }) });

  const result = await runTool(
    caller,
    'atc_terminal_choose',
    { session: 's1' },
    { callerSessionID: null },
  );

  expect(result.structured).toStrictEqual({ menu });

  expect(caller.requests).toStrictEqual([
    { m: 'session.menu', p: { session: 's1' }, required: ['session.menu'] },
  ]);
});

test('it sends a choice with its option, label and menu token', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ pressed: 'enter', menu: null }) });

  const result = await runTool(
    caller,
    'atc_terminal_choose',
    { session: 's1', menuToken: 'menu-of-the-test', option: 2, label: 'No' },
    { callerSessionID: null },
  );

  expect(result.structured).toStrictEqual({ pressed: 'enter', menu: null });

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.choose',
      p: { session: 's1', menuToken: 'menu-of-the-test', option: 2, label: 'No' },
      required: ['session.menu'],
    },
  ]);
});

test('it sends Escape on a menu with its menu token', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ pressed: 'escape', menu: null }) });

  await runTool(
    caller,
    'atc_terminal_choose',
    { session: 's1', menuToken: 'menu-of-the-test', key: 'escape' },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.choose',
      p: { session: 's1', menuToken: 'menu-of-the-test', key: 'escape' },
      required: ['session.menu'],
    },
  ]);
});

test('it refuses a choice without a menu token and sends nothing', () => {
  const caller = buildStubFleetCaller({ answer: () => ({ pressed: 'enter', menu: null }) });

  const chosen = runTool(
    caller,
    'atc_terminal_choose',
    { session: 's1', option: 1, label: 'Yes' },
    { callerSessionID: null },
  );

  expect(chosen).rejects.toMatchObject({ code: 'bad_args' });
  expect(caller.requests).toStrictEqual([]);
});

test('it refuses a menu read unsent when the daemon predates menus', () => {
  const tmp = setupTempDir('atc-run-tool-');

  const legacy = startStubLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: DAEMON_FEATURES.filter((feature) => feature !== 'session.menu'),
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const read = runTool(caller, 'atc_terminal_choose', { session: 's1' }, { callerSessionID: null });

  expect(read).rejects.toThrow(/^daemon_outdated: .*atc_terminal_choose/);
  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it stops a session without ever removing it and needs a daemon that stops only', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ stopped: true }) });

  const result = await runTool(
    caller,
    'atc_session_stop',
    { session: 's1' },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.kill',
      p: { session: 's1', stopOnly: true },
      required: ['session.kill.stopOnly'],
    },
  ]);

  expect(result.structured).toStrictEqual({ stopped: true });
});

test('it reports a session that had already exited as not stopped', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ stopped: false }) });

  const result = await runTool(
    caller,
    'atc_session_stop',
    { session: 's1' },
    { callerSessionID: null },
  );

  expect(result.structured).toStrictEqual({ stopped: false });
});

test('it refuses a stop unsent when the daemon predates stop-only kills', () => {
  const tmp = setupTempDir('atc-run-tool-');

  const legacy = startStubLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: DAEMON_FEATURES.filter((feature) => feature !== 'session.kill.stopOnly'),
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const stop = runTool(caller, 'atc_session_stop', { session: 's1' }, { callerSessionID: null });

  expect(stop).rejects.toThrow(/^daemon_outdated: .*atc_session_stop/);
  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it detaches a session through an update that needs a daemon that takes a null parent', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({}) });

  await runTool(
    caller,
    'atc_session_update',
    { session: 's1', parent: null },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.update',
      p: { session: 's1', parent: null },
      required: ['session.update.parent'],
    },
  ]);
});

test('it renames a session through an update that needs a daemon that reports a skipped rename', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({}) });

  const result = await runTool(
    caller,
    'atc_session_update',
    { session: 's1', name: 'from-mcp' },
    { callerSessionID: null },
  );

  expect(result).toStrictEqual({ text: 'updated', structured: null });

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.update',
      p: { session: 's1', name: 'from-mcp' },
      required: ['session.update.renameSkipped'],
    },
  ]);
});

test('it reports a rename the daemon skipped because the agent named the session', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ renameSkipped: 'agent_named' }) });

  const result = await runTool(
    caller,
    'atc_session_update',
    { session: 's1', name: 'from-mcp' },
    { callerSessionID: null },
  );

  expect(result).toStrictEqual({
    text: 'updated, not renamed: the agent named this session itself with /rename, and a name the agent sets wins over one set here. Any pin or detach in the call applied.',
    structured: null,
  });
});

test('it refuses a rename unsent when the daemon predates a reported skipped rename', () => {
  const tmp = setupTempDir('atc-run-tool-');

  const legacy = startStubLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: DAEMON_FEATURES.filter((feature) => feature !== 'session.update.renameSkipped'),
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const update = runTool(
    caller,
    'atc_session_update',
    { session: 's1', name: 'from-mcp' },
    { callerSessionID: null },
  );

  expect(update).rejects.toThrow(
    /^daemon_outdated: .*atc_session_update's report of a skipped rename/,
  );

  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it refuses a detach unsent when the daemon predates a null parent on update', () => {
  const tmp = setupTempDir('atc-run-tool-');

  const legacy = startStubLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: DAEMON_FEATURES.filter((feature) => feature !== 'session.update.parent'),
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const update = runTool(
    caller,
    'atc_session_update',
    { session: 's1', parent: null },
    { callerSessionID: null },
  );

  expect(update).rejects.toThrow(/^daemon_outdated: .*atc_session_update's parent/);
  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it answers a mark-read with the text marked read', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({}) });

  const result = await runTool(
    caller,
    'atc_session_mark_read',
    { session: 's1' },
    { callerSessionID: null },
  );

  expect(result).toStrictEqual({ text: 'marked read', structured: null });
});

test.each(['atc_report_get', 'atc_resume_command', 'atc_session_kill'])(
  'it no longer runs %s',
  (name) => {
    const caller = buildStubFleetCaller();

    expect(runTool(caller, name, {}, { callerSessionID: null })).rejects.toThrow(
      `unknown tool '${name}'`,
    );
  },
);

test('it forwards an explicit clone trust decision and requires daemon support', async () => {
  const workspace = { kind: 'git', url: 'https://example.com/r.git', ref: 'main' };
  const caller = buildStubFleetCaller({ answer: () => ({ session: { id: 's-1' } }) });

  await runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp/ws', workspace, trustClonedWorkspace: true },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.spawn',
      p: { cwd: '/tmp/ws', workspace, trustClonedWorkspace: true, cols: 100, rows: 30 },
      required: ['spawn.workspace', 'spawn.workspace.trust'],
    },
  ]);
});

test('it refuses an explicit trust decision unsent when the daemon predates clone trust', () => {
  const tmp = setupTempDir('atc-run-tool-');

  const legacy = startStubLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: [
      'agents.list',
      'events.more',
      'events.session',
      'message.turn',
      'message.wait',
      'spawn.workspace',
    ],
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const spawn = runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp/ws', workspace: { kind: 'path', path: '/src/repo' }, trustClonedWorkspace: true },
    { callerSessionID: null },
  );

  expect(spawn).rejects.toThrow(/^daemon_outdated: .*atc_session_spawn's trustClonedWorkspace/);
  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test.each([
  ['atc_events_read', {}],
  ['atc_message_send', { session: 's1', text: 'hello' }],
  ['atc_message_get', { message: 'm1' }],
])('it refuses %s unsent when the daemon predates the note and queued words', (name, args) => {
  const tmp = setupTempDir('atc-run-tool-');

  const legacy = startStubLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: ['events.more', 'events.session', 'message.wait', 'message.idempotency', 'note.get'],
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const call = runTool(caller, name, args, {
    callerSessionID: null,
  });

  expect(call).rejects.toThrow(/^daemon_outdated: .*note and queued words/);
  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});
