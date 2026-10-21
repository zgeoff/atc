import { expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, toAgentSessionID, toSessionID } from '@atc/core';
import { buildPayloadHash } from '@atc/daemon';
import { createImpProvider } from '@atc/execution-imp';
import { createStubImpPort, getOnlyImpName } from '@atc/execution-imp/testing';
import { createLocalPTYProvider } from '@atc/execution-local';
import { createStubExecutionProvider } from '@atc/execution-local/testing';
import { DaemonPool, GatewayStore, RoutingCaller } from '@atc/gateway';
import { buildMockRegistryDaemon, openTestBindingDatabase } from '@atc/gateway/testing';
import { TransportCaller, buildPrincipalCaller, runTool } from '@atc/mcp';
import { buildStubFleetCaller } from '@atc/mcp/testing';
import type { AgentAdapter } from '@atc/plugin-api';
import { REQUEST_PARAM_SCHEMAS } from '@atc/protocol';
import { openDaemonClient } from '@atc/protocol/client';
import { createStateStore } from '@atc/store';
import {
  buildMockAgentAdapter,
  buildStubBrokeredAgentAdapter,
  getRecord,
  registerTestCleanup,
  setupTempDir,
  spawnNamedSession,
  waitFor,
} from '@atc/test-utils';
import { $ } from 'bun';
import invariant from 'tiny-invariant';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

async function setupTest() {
  const planSpawn = mock<AgentAdapter['planSpawn']>(() => ({ bin: 'sleep', args: ['30'] }));

  const stubProvider = createStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-run-tool-',
    options: (paths) => {
      // The token the listener takes, which a gateway's pool presents.
      writeFileSync(join(paths.directory, 'token'), `${'c'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter({ planSpawn }),
        targets: [
          {
            id: 'local',
            kind: 'local-pty',
            options: {},
            identity: 'test:local',
            provider: createLocalPTYProvider(),
          },
          {
            id: 'box',
            kind: 'imp',
            options: {},
            identity: 'imp:test',
            provider: createImpProvider(
              createStubImpPort(),
              { guestDir: join(paths.directory, 'g') },
              { reconnectDelaysMs: [0, 0, 0], version: '1.0.0' },
            ),
          },
          {
            id: 'imp',
            kind: stubProvider.kind,
            options: {},
            identity: 'test:imp',
            provider: stubProvider,
          },
        ],

        // The daemon reads principals only at boot, so the remote clients
        // the reach tests act as are set here: ops may use box only, and a
        // gateway's principal, gw, may use the local target only.
        principals: new Map([
          ['ops', ['box']],
          ['gw', ['local']],
        ]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.directory, 'token') },
      };
    },
  });

  const caller = new TransportCaller(daemon.socketPath, daemon.build, (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  return { caller, planSpawn, stubProvider, daemon, directory: daemon.directory };
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
      method: 'session.message',
      params: { session: 's1', text: 'hello' },
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
      method: 'message.get',
      params: { message: 'm1', waitMs: 20_000 },
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
      method: 'events.read',
      params: { waitMs: 1000, session: 's1' },
    },
  ]);
});

test('it reads the whole text of each note of an events page by default', async () => {
  const answers: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
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

  const caller = buildStubFleetCaller({ answer: (request) => answers[request.method] ?? {} });

  const read = await runTool(
    caller,
    'atc_events_read',
    { cursor: 'c0' },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    {
      method: 'events.read',
      params: { cursor: 'c0' },
    },
    { method: 'note.get', params: { note: 'c1' } },
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
  const answers: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
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

  const caller = buildStubFleetCaller({ answer: (request) => answers[request.method] ?? {} });

  const read = await runTool(
    caller,
    'atc_events_read',
    { previewOnly: true },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([{ method: 'events.read', params: {} }]);

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
        request.method === 'events.read'
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
      request.method === 'events.read'
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
    method: 'note.get',
    params: { note: 'h1' },
  });
});

test("it returns a message's whole answer on its answered event by default", async () => {
  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  const caller = new TransportCaller(daemon.socketPath, daemon.build, (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

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

  const caller = new TransportCaller(daemon.socketPath, daemon.build, (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

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
    (feedEvent: unknown) => isRecord(feedEvent) && feedEvent['kind'] === 'message-answered',
  );

  expect(answered).toStrictEqual({
    cursor: expect.toBeString(),
    at: expect.toBeNumber(),
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
      request.method === 'events.read'
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
    method: 'answer.get',
    params: { answer: 'handle-1' },
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

test('it sends a message under the key the call gives', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ message: 'm1' }) });

  await runTool(
    caller,
    'atc_message_send',
    { session: 's1', text: 'hello', idempotencyKey: 'k-1' },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    {
      method: 'session.message',
      params: { session: 's1', text: 'hello', idempotencyKey: 'k-1' },
    },
  ]);
});

test.each([
  ['an unkeyed send', {}],
  ['a keyed send', { idempotencyKey: 'k-1' }],
] as const)('it passes no from on to the daemon for %s that gives one', async (_case, keyed) => {
  const caller = buildStubFleetCaller({ answer: () => ({ message: 'm1' }) });

  await runTool(
    caller,
    'atc_message_send',
    { session: 's1', text: 'hello', from: 'release-bot', ...keyed },
    { callerSessionID: null },
  );

  expect(caller.requests.map((request) => request.params)).toStrictEqual([
    { session: 's1', text: 'hello', ...keyed },
  ]);
});

test('it spawns top-level under a key of its own when the calling session is gone', async () => {
  const ctx = await setupTest();

  const relay = buildStubFleetCaller({
    answer: (request) => ctx.caller.sendRequest(request.method, request.params, request.principal),
  });

  await runTool(
    relay,
    'atc_session_spawn',
    { cwd: ctx.directory, idempotencyKey: 'k-1' },
    { callerSessionID: 'gone' },
  );

  expect(relay.requests).toStrictEqual([
    {
      method: 'session.spawn',
      params: { cwd: ctx.directory, idempotencyKey: 'k-1', cols: 100, rows: 30, parent: 'gone' },
    },
    {
      method: 'session.spawn',
      params: {
        cwd: ctx.directory,
        idempotencyKey:
          'top-level:7c35c5a1785d20704e44d5de4beb81c1fce91b6fe48ed7c3159af6f7f832078b',
        cols: 100,
        rows: 30,
      },
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
      const seed = await createStateStore(paths.dbPath);

      const stopSeed = registerTestCleanup(() => seed.stop());

      await seed.claimIdempotencyKey({
        principal: 'local',
        operation: 'session.spawn',
        key: 'k-1',
        payloadHash: buildPayloadHash(
          REQUEST_PARAM_SCHEMAS['session.spawn'].parse({
            cwd: paths.directory,
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
          cwd: paths.directory,
          agent: 'claude',
          exited: true,
        },
      ]);

      await stopSeed();

      return { adapter: buildMockAgentAdapter() };
    },
  });

  const caller = new TransportCaller(daemon.socketPath, daemon.build, (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const relay = buildStubFleetCaller({
    answer: (request) => caller.sendRequest(request.method, request.params, request.principal),
  });

  const call = runTool(
    relay,
    'atc_session_spawn',
    { cwd: daemon.directory, idempotencyKey: 'k-1' },
    { callerSessionID: 'parent' },
  );

  expect(call).rejects.toMatchObject({
    code: 'no_such_session',
    data: { effectRef: 'spawned-before-restart' },
  });

  expect(relay.requests).toStrictEqual([
    {
      method: 'session.spawn',
      params: {
        cwd: daemon.directory,
        idempotencyKey: 'k-1',
        cols: 100,
        rows: 30,
        parent: 'parent',
      },
    },
  ]);
});

test('it derives a top-level fallback key within the daemon cap from the longest key a call may pass', async () => {
  const ctx = await setupTest();

  const relay = buildStubFleetCaller({
    answer: (request) => ctx.caller.sendRequest(request.method, request.params, request.principal),
  });

  await runTool(
    relay,
    'atc_session_spawn',
    { cwd: ctx.directory, idempotencyKey: 'k'.repeat(180) },
    { callerSessionID: 'gone' },
  );

  expect(relay.requests.map((request) => request.params?.['idempotencyKey'])).toStrictEqual([
    'k'.repeat(180),
    expect.stringMatching(/^top-level:[0-9a-f]{64}$/u),
  ]);
});

test('it derives the same top-level fallback key when the call is retried', async () => {
  const ctx = await setupTest();

  const relay = buildStubFleetCaller({
    answer: (request) => ctx.caller.sendRequest(request.method, request.params, request.principal),
  });

  await runTool(
    relay,
    'atc_session_spawn',
    { cwd: ctx.directory, idempotencyKey: 'k'.repeat(180) },
    { callerSessionID: 'gone' },
  );

  await runTool(
    relay,
    'atc_session_spawn',
    { cwd: ctx.directory, idempotencyKey: 'k'.repeat(180) },
    { callerSessionID: 'gone' },
  );

  const keys = relay.requests.map((request) => request.params?.['idempotencyKey']);

  expect(keys).toStrictEqual([
    'k'.repeat(180),
    expect.stringMatching(/^top-level:[0-9a-f]{64}$/u),
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

test('it spawns on the target the call gives', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ session: { id: 's-1' } }) });

  await runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp', target: 'box' },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    {
      method: 'session.spawn',
      params: { cwd: '/tmp', target: 'box', cols: 100, rows: 30 },
    },
  ]);
});

test('it spawns with the workspace the call gives', async () => {
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
      method: 'session.spawn',
      params: { cwd: '/tmp/ws', workspace, cols: 100, rows: 30 },
    },
  ]);
});

test('it spawns a git workspace without a cwd and returns the directory the daemon picked under the home', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-run-tool-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['file'],
      homeDir: join(paths.directory, 'home'),
    }),
  });

  const caller = new TransportCaller(daemon.socketPath, daemon.build, (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const home = join(daemon.directory, 'home');
  const upstream = join(daemon.directory, 'upstream.git');
  const work = join(daemon.directory, 'work');

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

test('it submits a session input line', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({}) });

  await runTool(
    caller,
    'atc_terminal_type',
    { session: 's1', text: 'hello' },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    { method: 'session.submit', params: { session: 's1', text: 'hello' } },
  ]);
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
  expect(caller.requests).toStrictEqual([{ method: 'session.menu', params: { session: 's1' } }]);
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
      method: 'session.choose',
      params: { session: 's1', menuToken: 'menu-of-the-test', option: 2, label: 'No' },
    },
  ]);
});

test('it returns the partial flag of a choice whose menu the daemon could not read whole', async () => {
  const caller = buildStubFleetCaller({
    answer: () => ({
      pressed: 'enter',
      menu: {
        text: 'Pick a lamp for the porch',
        options: [{ option: 1, label: 'amber-lamp', checked: null, highlighted: true }],
        menuToken: 'menu-of-the-test',
      },
      partial: true,
    }),
  });

  const result = await runTool(
    caller,
    'atc_terminal_choose',
    { session: 's1', menuToken: 'menu-before-the-choice', option: 1, label: 'Yes' },
    { callerSessionID: null },
  );

  expect(result.structured).toStrictEqual({
    pressed: 'enter',
    menu: {
      text: 'Pick a lamp for the porch',
      options: [{ option: 1, label: 'amber-lamp', checked: null, highlighted: true }],
      menuToken: 'menu-of-the-test',
    },
    partial: true,
  });
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
      method: 'session.choose',
      params: { session: 's1', menuToken: 'menu-of-the-test', key: 'escape' },
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

test('it stops a session without ever removing it', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ stopped: true }) });

  const result = await runTool(
    caller,
    'atc_session_stop',
    { session: 's1' },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    {
      method: 'session.kill',
      params: { session: 's1', stopOnly: true },
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

test('it detaches a session through an update with a null parent', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({}) });

  await runTool(
    caller,
    'atc_session_update',
    { session: 's1', parent: null },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    {
      method: 'session.update',
      params: { session: 's1', parent: null },
    },
  ]);
});

test('it renames a session through an update', async () => {
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
      method: 'session.update',
      params: { session: 's1', name: 'from-mcp' },
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

test('it forwards an explicit clone trust decision', async () => {
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
      method: 'session.spawn',
      params: { cwd: '/tmp/ws', workspace, trustClonedWorkspace: true, cols: 100, rows: 30 },
    },
  ]);
});

test('it starts a stopped local session again with its agent session resumed', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.directory,
    target: 'local',
    resume: 'agent-session-1',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await runTool(ctx.caller, 'atc_session_stop', { session: id }, { callerSessionID: null });

  ctx.planSpawn.mockClear();

  const adopted = await runTool(
    ctx.caller,
    'atc_session_adopt',
    { session: id },
    { callerSessionID: null },
  );

  expect(adopted.structured).toStrictEqual({ adopted: true });

  expect(ctx.planSpawn.mock.calls.map(([opts]) => opts.resume)).toStrictEqual([
    toAgentSessionID('agent-session-1'),
  ]);

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, alive: true, kind: 'pty' }],
  });
});

test('it wakes the imp of a session that a stop put to sleep and starts the session on it', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.directory,
    target: 'box',
    resume: 'agent-session-1',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await runTool(ctx.caller, 'atc_session_stop', { session: id }, { callerSessionID: null });

  const slept = await ctx.caller.sendRequest('session.list');

  const adopted = await runTool(
    ctx.caller,
    'atc_session_adopt',
    { session: id },
    { callerSessionID: null },
  );

  expect(slept).toMatchObject({ sessions: [{ id, alive: false, lifecycle: { vm: 'asleep' } }] });
  expect(adopted.structured).toStrictEqual({ adopted: true });

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, alive: true, lifecycle: { vm: 'awake', harness: 'running' } }],
  });
});

test('it refuses a remote client a stopped session on a target outside its reach and starts nothing', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.directory,
    target: 'local',
    resume: 'agent-session-1',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await runTool(ctx.caller, 'atc_session_stop', { session: id }, { callerSessionID: null });

  ctx.planSpawn.mockClear();

  const remote = buildPrincipalCaller(ctx.caller, { id: 'ops', name: 'ops-console' });
  const refused = runTool(remote, 'atc_session_adopt', { session: id }, { callerSessionID: null });

  await refused.catch(() => null);

  expect(refused).rejects.toMatchObject({ code: 'no_such_session' });
  expect(ctx.planSpawn.mock.calls).toStrictEqual([]);

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, alive: false }],
  });
});

test('it lets a remote client wake a stopped session on a target in its reach', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.directory,
    target: 'box',
    resume: 'agent-session-1',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await runTool(ctx.caller, 'atc_session_stop', { session: id }, { callerSessionID: null });

  const remote = buildPrincipalCaller(ctx.caller, { id: 'ops', name: 'ops-console' });

  const adopted = await runTool(
    remote,
    'atc_session_adopt',
    { session: id },
    { callerSessionID: null },
  );

  expect(adopted.structured).toStrictEqual({ adopted: true });

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, alive: true }],
  });
});

test('it starts a stopped pinned session again, since a pin guards only against a forget', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.directory,
    target: 'local',
    resume: 'agent-session-1',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.caller.sendRequest('session.update', { session: id, pinned: true });

  await runTool(ctx.caller, 'atc_session_stop', { session: id }, { callerSessionID: null });

  const adopted = await runTool(
    ctx.caller,
    'atc_session_adopt',
    { session: id },
    { callerSessionID: null },
  );

  expect(adopted.structured).toStrictEqual({ adopted: true });

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, alive: true, pinned: true }],
  });
});

test('it returns the adopted session for atc_session_adopt through the gateway', async () => {
  const ctx = await setupTest();

  // A client of its own, since a connection takes one handshake.
  const prober = await openDaemonClient(ctx.daemon.socketPath);

  registerTestCleanup(() => {
    prober.stop();
  });

  const hello = await prober.sendHello(ctx.daemon.build);

  // The daemon as `cloud`, the one daemon a gateway's registry holds.
  const registry = {
    daemons: new Map([
      [
        'cloud',
        buildMockRegistryDaemon({
          name: 'cloud',
          address: { host: '127.0.0.1', port: Number(ctx.daemon.daemon.listenPort) },
          daemonID: String(hello['daemonID']),
          token: 'c'.repeat(32),
        }),
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const pool = new DaemonPool({
    registry,
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => pool.stop());

  const store = GatewayStore.open(openTestBindingDatabase(join(ctx.directory, 'gateway.db')));

  registerTestCleanup(() => {
    store.stop();
  });

  // The gateway's caller, acting as `gw` the way `atc-gateway` hands it to
  // the tool handlers.
  const caller = buildPrincipalCaller(new RoutingCaller({ registry, pool, store }), {
    id: 'gw',
    name: 'Harbor Desk',
  });

  const spawned = await caller.sendRequest('session.spawn', {
    cwd: ctx.directory,
    resume: `a-${randomUUID()}`,
  });

  const id = getRecord(spawned, 'session')['id'];

  await caller.sendRequest('session.kill', { session: id });

  const adopted = await runTool(
    caller,
    'atc_session_adopt',
    { session: id },
    { callerSessionID: null },
  );

  const got = await caller.sendRequest('session.get', { session: id });

  expect(adopted.structured).toStrictEqual({ adopted: true });
  expect(getRecord(got, 'session')['alive']).toBe(true);
});

test('it refuses atc_session_auth_rebind through the gateway as unauthorized, since the gateway acts as a remote client', async () => {
  const ctx = await setupTest();

  // A client of its own, since a connection takes one handshake.
  const prober = await openDaemonClient(ctx.daemon.socketPath);

  registerTestCleanup(() => {
    prober.stop();
  });

  const hello = await prober.sendHello(ctx.daemon.build);

  // The daemon as `cloud`, the one daemon a gateway's registry holds.
  const registry = {
    daemons: new Map([
      [
        'cloud',
        buildMockRegistryDaemon({
          name: 'cloud',
          address: { host: '127.0.0.1', port: Number(ctx.daemon.daemon.listenPort) },
          daemonID: String(hello['daemonID']),
          token: 'c'.repeat(32),
        }),
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const pool = new DaemonPool({
    registry,
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => pool.stop());

  const store = GatewayStore.open(openTestBindingDatabase(join(ctx.directory, 'gateway.db')));

  registerTestCleanup(() => {
    store.stop();
  });

  // The gateway's caller, acting as `gw` the way `atc-gateway` hands it to
  // the tool handlers.
  const caller = buildPrincipalCaller(new RoutingCaller({ registry, pool, store }), {
    id: 'gw',
    name: 'Harbor Desk',
  });

  const spawned = await caller.sendRequest('session.spawn', {
    cwd: ctx.directory,
    resume: `a-${randomUUID()}`,
  });

  const rebound = runTool(
    caller,
    'atc_session_auth_rebind',
    { session: getRecord(spawned, 'session')['id'] },
    { callerSessionID: null },
  );

  expect(rebound).rejects.toMatchObject({ code: 'unauthorized' });
});

test('it hands out a token and changes nothing for a live session on a host-destroying target', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.directory,
    target: 'imp',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const offered = await runTool(
    ctx.caller,
    'atc_session_forget',
    { session: id, stop: true },
    { callerSessionID: null },
  );

  expect(offered.structured).toStrictEqual({
    confirmToken: expect.toBeString(),
    expiresAt: expect.toBeNumber(),
  });

  expect(ctx.stubProvider.destroyed).toBeEmpty();

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, alive: true })],
  });
});

test('it destroys the host and drops the live session when the second call carries the token', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.directory,
    target: 'imp',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const offered = await runTool(
    ctx.caller,
    'atc_session_forget',
    { session: id, stop: true },
    { callerSessionID: null },
  );

  const forgotten = await runTool(
    ctx.caller,
    'atc_session_forget',
    { session: id, stop: true, confirmToken: offered.structured?.['confirmToken'] },
    { callerSessionID: null },
  );

  expect(forgotten.structured).toStrictEqual({ forgotten: true, destroyed: true });
  expect<readonly unknown[]>(ctx.stubProvider.destroyed).toStrictEqual([id]);

  expect(
    runTool(ctx.caller, 'atc_sessions_list', {}, { callerSessionID: null }),
  ).resolves.toStrictEqual({ text: expect.toBeString(), structured: { sessions: [] } });
});

test('it hands out a token for a dead session on a host-destroying target and changes nothing', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.directory,
    target: 'imp',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.caller.sendRequest('session.kill', { session: id });

  const offered = await runTool(
    ctx.caller,
    'atc_session_forget',
    { session: id },
    { callerSessionID: null },
  );

  expect(offered.structured).toStrictEqual({
    confirmToken: expect.toBeString(),
    expiresAt: expect.toBeNumber(),
  });

  expect(ctx.stubProvider.destroyed).toBeEmpty();

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, alive: false })],
  });
});

test('it forgets a dead session on a local target in one call', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.caller.sendRequest('session.kill', { session: id });

  const forgotten = await runTool(
    ctx.caller,
    'atc_session_forget',
    { session: id },
    { callerSessionID: null },
  );

  expect(forgotten.structured).toStrictEqual({ forgotten: true, destroyed: false });

  expect(
    runTool(ctx.caller, 'atc_sessions_list', {}, { callerSessionID: null }),
  ).resolves.toStrictEqual({ text: expect.toBeString(), structured: { sessions: [] } });
});

test('it stops and forgets a live session on a local target in one call when stop is true', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const forgotten = await runTool(
    ctx.caller,
    'atc_session_forget',
    { session: id, stop: true },
    { callerSessionID: null },
  );

  expect(forgotten.structured).toStrictEqual({ forgotten: true, destroyed: false });

  expect(
    runTool(ctx.caller, 'atc_sessions_list', {}, { callerSessionID: null }),
  ).resolves.toStrictEqual({ text: expect.toBeString(), structured: { sessions: [] } });
});

test('it refuses a live session without stop and leaves it running', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.directory,
    target: 'imp',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const refused = runTool(
    ctx.caller,
    'atc_session_forget',
    { session: id },
    { callerSessionID: null },
  );

  expect(refused).rejects.toThrowWithMessage(Error, /^session_live: .*stop: true/u);

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, alive: true })],
  });
});

test('it refuses a pinned session and leaves it listed', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.caller.sendRequest('session.update', { session: id, pinned: true });

  const refused = runTool(
    ctx.caller,
    'atc_session_forget',
    { session: id, stop: true },
    { callerSessionID: null },
  );

  expect(refused).rejects.toThrowWithMessage(Error, /^session_pinned: .*atc_session_update/u);

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, pinned: true, alive: true })],
  });
});

test('it refuses a sub-session of a pinned session and leaves both listed', async () => {
  const ctx = await setupTest();

  const spawnedParent = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const parent = getRecord(spawnedParent, 'session')['id'];

  const spawnedChild = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
    parent,
  });

  const child = getRecord(spawnedChild, 'session')['id'];

  await ctx.caller.sendRequest('session.update', { session: parent, pinned: true });

  const refused = runTool(
    ctx.caller,
    'atc_session_forget',
    { session: child, stop: true },
    { callerSessionID: null },
  );

  expect(refused).rejects.toThrowWithMessage(Error, /^session_pinned: /u);

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id: parent }), expect.objectContaining({ id: child })],
  });
});

test('it refuses a session a pin reaches just before the forget does', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  // The pin lands on the daemon right before each request the tool sends,
  // the forget among them.
  const pinning = buildStubFleetCaller({
    answer: async (request) => {
      await ctx.caller.sendRequest('session.update', { session: id, pinned: true });

      return ctx.caller.sendRequest(request.method, request.params, request.principal);
    },
  });

  const refused = runTool(
    pinning,
    'atc_session_forget',
    { session: id, stop: true },
    { callerSessionID: null },
  );

  expect(refused).rejects.toThrowWithMessage(Error, /^session_pinned: .*atc_session_update/u);

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, pinned: true, alive: true })],
  });
});

test('it refuses an unknown session as no_such_session before any token exists', async () => {
  const ctx = await setupTest();

  const refused = runTool(
    ctx.caller,
    'atc_session_forget',
    { session: 'nope', stop: true },
    { callerSessionID: null },
  );

  expect(refused).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it refuses a principal a session on a target it cannot use as no_such_session and keeps the session', async () => {
  const provider = createStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-run-tool-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
      principals: new Map([['outsider', ['elsewhere']]]),
    }),
  });

  const caller = new TransportCaller(daemon.socketPath, daemon.build, (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const spawned = await caller.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const refused = runTool(
    buildPrincipalCaller(caller, { id: 'outsider', name: 'Lantern Notes' }),
    'atc_session_forget',
    { session: id, stop: true },
    { callerSessionID: null },
  );

  expect(refused).rejects.toMatchObject({ code: 'no_such_session' });

  expect(caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, alive: true })],
  });

  expect(provider.destroyed).toBeEmpty();
});

test('it rebinds the host of a session whose restore was refused for a changed auth selection', async () => {
  const temporaryDirectory = setupTempDir('atc-run-tool-auth-');
  const port = createStubImpPort();

  const provider = createImpProvider(
    port,
    { guestDir: join(temporaryDirectory.path, 'g'), rebindChangedAuth: false },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-run-tool-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: createLocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider },
      ],
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: temporaryDirectory.path,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = getOnlyImpName(port);

  judgeSelected = true;

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const caller = new TransportCaller(daemon.socketPath, daemon.build, (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const rebound = await runTool(
    caller,
    'atc_session_auth_rebind',
    { session: id },
    { callerSessionID: null },
  );

  const grants = await port.readGrants(imp);

  expect(rebound.structured).toStrictEqual({ revision: 2, restartPending: [id] });
  expect(grants).toIncludeSameMembers(['glm', 'judge']);
});

test('it adopts a session whose restore was refused once its host is rebound', async () => {
  const temporaryDirectory = setupTempDir('atc-run-tool-auth-');
  const port = createStubImpPort();

  const provider = createImpProvider(
    port,
    { guestDir: join(temporaryDirectory.path, 'g'), rebindChangedAuth: false },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-run-tool-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: createLocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider },
      ],
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: temporaryDirectory.path,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  judgeSelected = true;

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const caller = new TransportCaller(daemon.socketPath, daemon.build, (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const toolContext = { callerSessionID: null };

  await runTool(caller, 'atc_session_auth_rebind', { session: id }, toolContext);

  const adopted = await runTool(caller, 'atc_session_adopt', { session: id }, toolContext);
  const got = await daemon.client.sendRequest('session.get', { session: id });

  expect(adopted.structured).toStrictEqual({ adopted: true });
  expect(getRecord(got, 'session')).toMatchObject({ kind: 'pty', alive: true });
});

test('it refuses a rebind from a remote client acting as a principal and binds nothing', async () => {
  const temporaryDirectory = setupTempDir('atc-run-tool-auth-');
  const port = createStubImpPort();

  const provider = createImpProvider(
    port,
    { guestDir: join(temporaryDirectory.path, 'g'), rebindChangedAuth: false },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-run-tool-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: createLocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider },
      ],
      defaultTarget: 'box',

      // The remote client acts as ops, which may use box.
      principals: new Map([['ops', ['box']]]),
    }),
  });

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: temporaryDirectory.path,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = getOnlyImpName(port);

  judgeSelected = true;

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const owner = new TransportCaller(daemon.socketPath, daemon.build, (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => owner.stop());

  const caller = buildPrincipalCaller(owner, { id: 'ops', name: 'ops-console' });

  const rebound = runTool(
    caller,
    'atc_session_auth_rebind',
    { session: id },
    { callerSessionID: null },
  );

  await rebound.catch(() => null);

  const grants = await port.readGrants(imp);

  expect(rebound).rejects.toMatchObject({ code: 'unauthorized' });
  expect(grants).toStrictEqual(['glm']);
});
