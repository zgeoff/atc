import { expect, test } from 'bun:test';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '@atc/core/is-record';
import { DaemonClient } from '@atc/protocol/client/daemon-client';
import { buildMockAgentAdapter } from '@atc/test-utils/build-mock-agent-adapter';
import { getRecord } from '@atc/test-utils/get-record';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { startStubLegacyDaemon } from '@atc/test-utils/start-stub-legacy-daemon';
import invariant from 'tiny-invariant';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { answerRPCRequest } from './answer-rpc-request';
import { ReconnectingCaller } from './reconnecting-caller';

// A real daemon whose one agent is a `claude` that is not installed and
// whose sessions run `sleep`, and `atc mcp`'s caller in front of it.
async function setupTest() {
  const daemon = await startTestDaemon({
    prefix: 'atc-answer-rpc-',
    options: () => ({ adapter: buildMockAgentAdapter() }),
  });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  return { caller, dir: daemon.dir };
}

test('it refuses a tool call whose scope the caller lacks and leaves the session running', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'claude',
    cols: 80,
    rows: 24,
  });

  const sessionID = String(getRecord(spawned, 'session')['id']);

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_session_stop', arguments: { session: sessionID } },
    },
    {
      caller: ctx.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null },
      scopes: ['read', 'message'],
    },
  );

  expect(outcome).toStrictEqual({ kind: 'forbidden', scope: 'kill' });

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id: sessionID, alive: true })],
  });
});

test('it refuses a forget whose scope the caller lacks and leaves the session listed', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'claude',
    cols: 80,
    rows: 24,
  });

  const sessionID = String(getRecord(spawned, 'session')['id']);

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_session_forget', arguments: { session: sessionID, stop: true } },
    },
    {
      caller: ctx.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null },
      scopes: ['read', 'message', 'spawn'],
    },
  );

  expect(outcome).toStrictEqual({ kind: 'forbidden', scope: 'kill' });

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id: sessionID, alive: true })],
  });
});

test('it runs a tool call whose scope the caller holds', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'claude',
    cols: 80,
    rows: 24,
  });

  const sessionID = String(getRecord(spawned, 'session')['id']);

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_sessions_list', arguments: {} },
    },
    {
      caller: ctx.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null },
      scopes: ['read'],
    },
  );

  invariant(outcome.kind === 'reply', 'no reply');

  const result = getRecord(outcome.body, 'result');
  const content: unknown = result['content'];

  invariant(
    Array.isArray(content) && isRecord(content[0]) && typeof content[0]['text'] === 'string',
    'no text content',
  );

  expect(JSON.parse(content[0]['text'])).toStrictEqual(
    getRecord(result, 'structuredContent')['sessions'],
  );

  expect(outcome).toStrictEqual({
    kind: 'reply',
    body: {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.toBeString() }],
        structuredContent: {
          sessions: [expect.objectContaining({ id: sessionID, alive: true })],
        },
      },
    },
  });
});

test('it returns a tool result object as structured content beside its JSON text', async () => {
  const ctx = await setupTest();

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_events_read', arguments: {} },
    },
    {
      caller: ctx.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null },
    },
  );

  invariant(outcome.kind === 'reply', 'no reply');

  const result = getRecord(outcome.body, 'result');
  const content: unknown = result['content'];

  invariant(
    Array.isArray(content) && isRecord(content[0]) && typeof content[0]['text'] === 'string',
    'no text content',
  );

  expect(result['structuredContent']).toStrictEqual({
    events: [],
    cursor: expect.toBeString(),
    more: false,
  });

  expect(JSON.parse(content[0]['text'])).toStrictEqual(result['structuredContent']);
});

test('it lists every tool to a caller with one scope', async () => {
  const ctx = await setupTest();

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      caller: ctx.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null },
      scopes: ['read'],
    },
  );

  expect(outcome).toStrictEqual({
    kind: 'reply',
    body: {
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [
          expect.objectContaining({ name: 'atc_sessions_list' }),
          expect.objectContaining({ name: 'atc_session_spawn' }),
          expect.objectContaining({ name: 'atc_terminal_type' }),
          expect.objectContaining({ name: 'atc_terminal_read' }),
          expect.objectContaining({ name: 'atc_session_scope_add' }),
          expect.objectContaining({ name: 'atc_session_update' }),
          expect.objectContaining({ name: 'atc_session_stop' }),
          expect.objectContaining({ name: 'atc_session_forget' }),
          expect.objectContaining({ name: 'atc_session_adopt' }),
          expect.objectContaining({ name: 'atc_session_auth_rebind' }),
          expect.objectContaining({ name: 'atc_session_mark_read' }),
          expect.objectContaining({ name: 'atc_recent_dirs_list' }),
          expect.objectContaining({ name: 'atc_spawn_options_get' }),
          expect.objectContaining({ name: 'atc_session_get' }),
          expect.objectContaining({ name: 'atc_transcript_read' }),
          expect.objectContaining({ name: 'atc_events_read' }),
          expect.objectContaining({ name: 'atc_message_send' }),
          expect.objectContaining({ name: 'atc_message_get' }),
        ],
      },
    },
  });
});

test('it refuses a call to an unknown tool as needing kill when the caller is scoped', async () => {
  const ctx = await setupTest();

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_unknown_tool', arguments: {} },
    },
    {
      caller: ctx.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null },
      scopes: ['read', 'message', 'spawn'],
    },
  );

  expect(outcome).toStrictEqual({ kind: 'forbidden', scope: 'kill' });
});

test('it lists the agents to a caller holding only the read scope', async () => {
  const ctx = await setupTest();

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_spawn_options_get', arguments: {} },
    },
    {
      caller: ctx.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null },
      scopes: ['read'],
    },
  );

  invariant(outcome.kind === 'reply', 'no reply');

  const result = getRecord(outcome.body, 'result');
  const content: unknown = result['content'];

  invariant(
    Array.isArray(content) && isRecord(content[0]) && typeof content[0]['text'] === 'string',
    'no text content',
  );

  expect(JSON.parse(content[0]['text'])).toStrictEqual(result['structuredContent']);

  expect(outcome).toStrictEqual({
    kind: 'reply',
    body: {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.toBeString() }],
        structuredContent: {
          daemon: {
            hostname: hostname(),
            platform: process.platform,
            arch: process.arch,
            build: 'atc/test-build',
          },
          agents: [
            {
              id: 'claude',
              label: 'claude',
              kind: 'claude',
              installed: false,
              brokerAuth: false,
              brokerRequired: false,
              capabilities: {
                spawn: false,
                readTranscript: false,
                message: false,
                attach: true,
                screen: true,
                input: true,
              },
              models: null,
              spawnOptions: {
                model: {
                  supported: false,
                  available: false,
                  values: null,
                  examples: [],
                  default: null,
                  backendEffect: null,
                  note: null,
                },
                effort: {
                  supported: false,
                  available: false,
                  values: null,
                  examples: [],
                  default: null,
                  backendEffect: null,
                  note: null,
                },
              },
            },
          ],
          targets: [
            {
              id: 'local',
              provider: 'local-pty',
              identity: expect.toStartWith('local-pty:'),
              available: true,
              default: true,
              capabilities: {
                spawn: true,
                attach: true,
                input: true,
                resize: true,
                kill: true,
                transfer: true,
                run: true,
                headless: true,
                suspend: false,
                destroy: false,
              },
              brokerAuth: false,
            },
          ],
          spawnDefaults: { agent: 'claude', target: 'local' },
          configRevision: expect.toBeString(),
          targetErrors: [],
          sources: [],
        },
      },
    },
  });
});

test('it answers a tool list with an error when no daemon listens on the socket', async () => {
  const tmp = setupTempDir('atc-answer-rpc-');

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 7, method: 'tools/list' },
    {
      caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null },
    },
  );

  expect(outcome).toStrictEqual({
    kind: 'reply',
    body: { jsonrpc: '2.0', id: 7, error: { code: -32_603, message: expect.toBeString() } },
  });
});

test('it leaves the agents tool out of the list when the connected daemon does not announce it', async () => {
  const tmp = setupTempDir('atc-answer-rpc-');

  startStubLegacyDaemon(join(tmp.dir, 'daemon.sock'));

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    {
      caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null },
    },
  );

  invariant(outcome.kind === 'reply', 'no reply');

  const tools: unknown = getRecord(outcome.body, 'result')['tools'];

  invariant(Array.isArray(tools), 'no tools array');

  expect(tools).not.toPartiallyContain({ name: 'atc_spawn_options_get' });
});

test('it lists the message tool in its older form when the connected daemon announces no features', async () => {
  const tmp = setupTempDir('atc-answer-rpc-');

  startStubLegacyDaemon(join(tmp.dir, 'daemon.sock'));

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    {
      caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null },
    },
  );

  invariant(outcome.kind === 'reply', 'no reply');

  const tools: unknown = getRecord(outcome.body, 'result')['tools'];

  invariant(Array.isArray(tools), 'no tools array');

  const messageGet: unknown = tools.find(
    (tool) => isRecord(tool) && tool['name'] === 'atc_message_get',
  );

  invariant(isRecord(messageGet), 'atc_message_get is not listed');

  expect(messageGet).toStrictEqual({
    name: 'atc_message_get',
    description:
      'Read one message sent with atc_message_send. A sender inside an atc session that takes messages gets the outcome as an <atc-answer> notice. Every other caller has no inbox, so this read is how it learns the outcome: a caller outside a session, a remote client, or a session whose agent takes no messages (capabilities.message false in atc_spawn_options_get). A caller may also use it to wait on one message. It returns sender (who sent the message, as atc labelled it), status (queued, delivered, answered or unanswered), the answer once answered, unansweredReason once unanswered, turn, answeredWith and timestamps. unanswered means the turn that carried the message ended without an answer, or the process of its session ended while the message was delivered (unansweredReason session_ended), and is final: atc never delivers the message again, so send it again to retry. The answer is the final reply of the turn that carried the message; messages in one turn share it, and answeredWith lists them. Pass waitMs, up to 30000, to hold the call until the status changes; an answered or unanswered message returns at once. Ids and statuses persist, so call again after a timeout.',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message id atc_message_send returned' },
      },
      required: ['message'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  });
});

test.each([
  ['atc_message_get', { message: 'm-1', waitMs: 5000 }],
  ['atc_events_read', { session: 's-1' }],
  ['atc_spawn_options_get', {}],
])(
  'it refuses %p called with %p with a restart hint when the connected daemon predates it, sending nothing',
  async (name, args) => {
    const tmp = setupTempDir('atc-answer-rpc-');
    const legacy = startStubLegacyDaemon(join(tmp.dir, 'daemon.sock'));

    const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
      DaemonClient.open(path),
    );

    registerTestCleanup(() => caller.stop());

    const outcome = await answerRPCRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      {
        caller,
        build: 'atc/test-build',
        toolContext: { callerSessionID: null },
      },
    );

    expect(outcome).toStrictEqual({
      kind: 'reply',
      body: {
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [
            {
              type: 'text',
              text: expect.toStartWith('daemon_outdated: ') as string,
            },
          ],
          isError: true,
        },
      },
    });

    expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
  },
);

test.each([
  ['model', 'opus'],
  ['effort', 'high'],
])(
  'it refuses a spawn with the %p option %p with a restart hint when the connected daemon predates it, sending nothing',
  async (option, value) => {
    const tmp = setupTempDir('atc-answer-rpc-');
    const legacy = startStubLegacyDaemon(join(tmp.dir, 'daemon.sock'));

    const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
      DaemonClient.open(path),
    );

    registerTestCleanup(() => caller.stop());

    const outcome = await answerRPCRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'atc_session_spawn',
          arguments: { cwd: tmp.dir, [option]: value },
        },
      },
      {
        caller,
        build: 'atc/test-build',
        toolContext: { callerSessionID: null },
      },
    );

    expect(outcome).toStrictEqual({
      kind: 'reply',
      body: {
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [
            {
              type: 'text',
              text: expect.toStartWith('daemon_outdated: ') as string,
            },
          ],
          isError: true,
        },
      },
    });

    expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
  },
);

test('it reads a message from an older daemon when the call asks for no wait', async () => {
  const tmp = setupTempDir('atc-answer-rpc-');

  startStubLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: ['vocabulary.note', 'message.unanswered'],
    replies: {
      'message.get': {
        message: 'm-legacy',
        session: 's-legacy',
        from: 'tester',
        text: 'hello',
        status: 'queued',
        sentAt: 1_700_000_000_000,
      },
    },
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_message_get', arguments: { message: 'm-legacy' } },
    },
    {
      caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null },
    },
  );

  expect(outcome).toStrictEqual({
    kind: 'reply',
    body: {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: `{
  "message": "m-legacy",
  "session": "s-legacy",
  "from": "tester",
  "text": "hello",
  "status": "queued",
  "sentAt": 1700000000000
}`,
          },
        ],
        structuredContent: {
          message: 'm-legacy',
          session: 's-legacy',
          from: 'tester',
          text: 'hello',
          status: 'queued',
          sentAt: 1_700_000_000_000,
        },
      },
    },
  });
});

test('it names the registered agents in the spawn tool to a caller holding the read scope', async () => {
  const ctx = await setupTest();

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      caller: ctx.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null },
      scopes: ['read'],
    },
  );

  invariant(outcome.kind === 'reply', 'no reply');

  const tools: unknown = getRecord(outcome.body, 'result')['tools'];

  invariant(Array.isArray(tools), 'no tools array');

  const spawn: unknown = tools.find(
    (tool) => isRecord(tool) && tool['name'] === 'atc_session_spawn',
  );

  invariant(isRecord(spawn), 'atc_session_spawn is not listed');

  const properties = getRecord(getRecord(spawn, 'inputSchema'), 'properties');

  expect(spawn['description']).toBe(
    'Start a new agent session in a directory and return its entry. prompt goes to the agent CLI as its first message at launch; the result does not show that the agent took it, so follow with atc_events_read. agent defaults to claude when it is registered, else the first registered agent. When this tool list was built, the host registered: claude (not installed). atc_spawn_options_get lists the agents, targets, models and effort levels this daemon takes, and anything else is refused before anything starts. Called from inside an atc session, the new session is a sub-session of the caller unless detached is true: listed under it, pinned and stopped with it, forgettable while it is pinned only by a call from inside the caller, and reached by a remote client only when the client reaches the caller. atc_session_update with parent null detaches it later. A directory the agent has not trusted opens its folder-trust dialog, which only a person can answer in the TUI; trustClonedWorkspace trusts a fresh workspace clone. A retry with the same idempotencyKey and arguments returns the first result.',
  );

  expect(getRecord(properties, 'agent')['description']).toBe(
    'Registered agent id to spawn; defaults to claude when it is registered, else the first registered agent. When this tool list was built, the host registered: claude (not installed). atc_spawn_options_get returns the current list.',
  );
});

test('it names no agent in the spawn tool to a caller without the read scope', async () => {
  const ctx = await setupTest();

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      caller: ctx.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null },
      scopes: ['kill'],
    },
  );

  invariant(outcome.kind === 'reply', 'no reply');

  const tools: unknown = getRecord(outcome.body, 'result')['tools'];

  invariant(Array.isArray(tools), 'no tools array');

  const spawn: unknown = tools.find(
    (tool) => isRecord(tool) && tool['name'] === 'atc_session_spawn',
  );

  invariant(isRecord(spawn), 'atc_session_spawn is not listed');

  const properties = getRecord(getRecord(spawn, 'inputSchema'), 'properties');

  expect(spawn['description']).toBe(
    'Start a new agent session in a directory and return its entry. prompt goes to the agent CLI as its first message at launch; the result does not show that the agent took it, so follow with atc_events_read. agent defaults to claude when it is registered, else the first registered agent. atc_spawn_options_get lists the agents, targets, models and effort levels this daemon takes, and anything else is refused before anything starts. Called from inside an atc session, the new session is a sub-session of the caller unless detached is true: listed under it, pinned and stopped with it, forgettable while it is pinned only by a call from inside the caller, and reached by a remote client only when the client reaches the caller. atc_session_update with parent null detaches it later. A directory the agent has not trusted opens its folder-trust dialog, which only a person can answer in the TUI; trustClonedWorkspace trusts a fresh workspace clone. A retry with the same idempotencyKey and arguments returns the first result.',
  );

  expect(getRecord(properties, 'agent')['description']).toBe(
    'Registered agent id to spawn; defaults to claude when it is registered, else the first registered agent. atc_spawn_options_get returns the current list.',
  );
});

test('it lists the agents tool without an output schema when the daemon takes no spawn options', async () => {
  const tmp = setupTempDir('atc-answer-rpc-');

  startStubLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: ['agents.list', 'events.more', 'events.session', 'message.turn', 'message.wait'],
    replies: {
      'agents.list': {
        daemon: {
          hostname: 'legacy-host',
          platform: 'linux',
          arch: 'x64',
          build: 'atc/legacy-build',
        },
        agents: [
          {
            id: 'claude',
            label: 'Claude',
            kind: 'claude',
            installed: true,
            capabilities: {
              spawn: true,
              readTranscript: true,
              message: true,
              attach: true,
              screen: true,
              input: true,
            },
            models: null,
          },
        ],
      },
    },
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const listed = await answerRPCRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    {
      caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null },
    },
  );

  invariant(listed.kind === 'reply', 'no reply');

  const tools: unknown = getRecord(listed.body, 'result')['tools'];

  invariant(Array.isArray(tools), 'no tools array');

  const agentsTool: unknown = tools.find(
    (tool) => isRecord(tool) && tool['name'] === 'atc_spawn_options_get',
  );

  invariant(isRecord(agentsTool), 'atc_spawn_options_get is not listed');

  expect(agentsTool).not.toContainKey('outputSchema');
});

test('it returns the agents a daemon without spawn options lists', async () => {
  const tmp = setupTempDir('atc-answer-rpc-');

  startStubLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: ['agents.list', 'events.more', 'events.session', 'message.turn', 'message.wait'],
    replies: {
      'agents.list': {
        daemon: {
          hostname: 'legacy-host',
          platform: 'linux',
          arch: 'x64',
          build: 'atc/legacy-build',
        },
        agents: [
          {
            id: 'claude',
            label: 'Claude',
            kind: 'claude',
            installed: true,
            capabilities: {
              spawn: true,
              readTranscript: true,
              message: true,
              attach: true,
              screen: true,
              input: true,
            },
            models: null,
          },
        ],
      },
    },
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const called = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'atc_spawn_options_get', arguments: {} },
    },
    {
      caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null },
    },
  );

  invariant(called.kind === 'reply', 'no reply');

  expect(getRecord(getRecord(called.body, 'result'), 'structuredContent')['agents']).toStrictEqual([
    {
      id: 'claude',
      label: 'Claude',
      kind: 'claude',
      installed: true,
      capabilities: {
        spawn: true,
        readTranscript: true,
        message: true,
        attach: true,
        screen: true,
        input: true,
      },
      models: null,
    },
  ]);
});
