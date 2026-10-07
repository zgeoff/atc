import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { getRecord } from '../shared/get-record';
import { isRecord } from '../shared/report';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startLegacyDaemon } from '../test-utils/start-legacy-daemon';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { answerRPCRequest } from './answer-rpc-request';
import { ReconnectingCaller } from './reconnecting-caller';

// A real daemon whose one agent is a `claude` that is not installed and
// whose sessions run `sleep`, one session running on it, and `atc mcp`'s
// caller in front of it.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const daemon = await startTestDaemon({
    prefix: 'atc-answer-rpc-',
    options: () => ({ adapter: buildMockAgentAdapter() }),
  });

  stack.use(daemon);

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  stack.defer(() => caller.stop());

  const spawned = await caller.sendRequest('session.spawn', {
    cwd: daemon.dir,
    agent: 'claude',
    cols: 80,
    rows: 24,
  });

  const owned = stack.move();

  return {
    caller,
    sessionID: String(getRecord(spawned, 'session')['id']),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it refuses a tool call whose scope the caller lacks and leaves the session running', async () => {
  await using ctx = await setupTest();

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_session_kill', arguments: { session: ctx.sessionID } },
    },
    {
      caller: ctx.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      scopes: ['read', 'message'],
    },
  );

  expect(outcome).toStrictEqual({ kind: 'forbidden', scope: 'kill' });

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id: ctx.sessionID, alive: true })],
  });
});

test('it refuses a forget whose scope the caller lacks and leaves the session listed', async () => {
  await using ctx = await setupTest();

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_session_forget', arguments: { session: ctx.sessionID, stop: true } },
    },
    {
      caller: ctx.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      scopes: ['read', 'message', 'spawn'],
    },
  );

  expect(outcome).toStrictEqual({ kind: 'forbidden', scope: 'kill' });

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id: ctx.sessionID, alive: true })],
  });
});

test('it runs a tool call whose scope the caller holds', async () => {
  await using ctx = await setupTest();

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_session_list', arguments: {} },
    },
    {
      caller: ctx.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      scopes: ['read'],
    },
  );

  if (outcome.kind !== 'reply') {
    throw new Error('no reply');
  }

  const result = getRecord(outcome.body, 'result');
  const content: unknown = result['content'];

  if (!Array.isArray(content) || !isRecord(content[0]) || typeof content[0]['text'] !== 'string') {
    throw new TypeError('no text content');
  }

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
          sessions: [expect.objectContaining({ id: ctx.sessionID, alive: true })],
        },
      },
    },
  });
});

test('it returns a tool result object as structured content beside its JSON text', async () => {
  await using ctx = await setupTest();

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
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
    },
  );

  if (outcome.kind !== 'reply') {
    throw new Error('no reply');
  }

  const result = getRecord(outcome.body, 'result');
  const content: unknown = result['content'];

  if (!Array.isArray(content) || !isRecord(content[0]) || typeof content[0]['text'] !== 'string') {
    throw new TypeError('no text content');
  }

  expect(result['structuredContent']).toStrictEqual({
    events: [],
    cursor: expect.toBeString(),
    more: false,
  });

  expect(JSON.parse(content[0]['text'])).toStrictEqual(result['structuredContent']);
});

test('it lists every tool to a caller with one scope', async () => {
  await using ctx = await setupTest();

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      caller: ctx.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      scopes: ['read'],
    },
  );

  expect(outcome).toMatchObject({
    kind: 'reply',
    body: { result: { tools: expect.toBeArrayOfSize(17) } },
  });
});

test('it refuses a call to an unknown tool as needing kill when the caller is scoped', async () => {
  await using ctx = await setupTest();

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
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      scopes: ['read', 'message', 'spawn'],
    },
  );

  expect(outcome).toStrictEqual({ kind: 'forbidden', scope: 'kill' });
});

test('it lists the agents to a caller holding only the read scope', async () => {
  await using ctx = await setupTest();

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_agents_list', arguments: {} },
    },
    {
      caller: ctx.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      scopes: ['read'],
    },
  );

  expect(outcome).toMatchObject({
    kind: 'reply',
    body: {
      result: {
        structuredContent: {
          daemon: { build: 'atc/test-build', platform: process.platform, arch: process.arch },
          agents: [{ id: 'claude', kind: 'claude', installed: false, models: null }],
        },
      },
    },
  });
});

test('it leaves the agents tool out of the list when the connected daemon does not announce it', async () => {
  using tmp = setupTempDir('atc-answer-rpc-');

  const legacy = startLegacyDaemon(join(tmp.dir, 'daemon.sock'));

  onTestFinished(() => {
    legacy.stop();
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    {
      caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
    },
  );

  if (outcome.kind !== 'reply') {
    throw new Error('no reply');
  }

  const tools: unknown = getRecord(outcome.body, 'result')['tools'];

  if (!Array.isArray(tools)) {
    throw new TypeError('no tools array');
  }

  expect(tools).not.toPartiallyContain({ name: 'atc_agents_list' });
});

test('it lists the message tool in its older form when the connected daemon announces no features', async () => {
  using tmp = setupTempDir('atc-answer-rpc-');

  const legacy = startLegacyDaemon(join(tmp.dir, 'daemon.sock'));

  onTestFinished(() => {
    legacy.stop();
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    {
      caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
    },
  );

  if (outcome.kind !== 'reply') {
    throw new Error('no reply');
  }

  const tools: unknown = getRecord(outcome.body, 'result')['tools'];

  if (!Array.isArray(tools)) {
    throw new TypeError('no tools array');
  }

  const messageGet: unknown = tools.find(
    (tool) => isRecord(tool) && tool['name'] === 'atc_message_get',
  );

  if (!isRecord(messageGet)) {
    throw new Error('atc_message_get is not listed');
  }

  expect(messageGet).toMatchObject({
    inputSchema: { properties: { message: { type: 'string' } } },
  });

  expect(messageGet).not.toContainKey('outputSchema');
});

test.each([
  ['atc_message_get', { message: 'm-1', waitMs: 5000 }],
  ['atc_events_read', { session: 's-1' }],
  ['atc_agents_list', {}],
])(
  'it refuses %p called with %p with a restart hint when the connected daemon predates it, sending nothing',
  async (name, args) => {
    using tmp = setupTempDir('atc-answer-rpc-');
    using legacy = startLegacyDaemon(join(tmp.dir, 'daemon.sock'));

    const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
      DaemonClient.open(path),
    );

    onTestFinished(() => caller.stop());

    const outcome = await answerRPCRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      {
        caller,
        build: 'atc/test-build',
        toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
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
    using tmp = setupTempDir('atc-answer-rpc-');
    using legacy = startLegacyDaemon(join(tmp.dir, 'daemon.sock'));

    const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
      DaemonClient.open(path),
    );

    onTestFinished(() => caller.stop());

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
        toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
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
  using tmp = setupTempDir('atc-answer-rpc-');

  const legacy = startLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    replies: {
      'message.get': {
        message: 'm-legacy',
        session: 's-legacy',
        from: 'tester',
        text: 'hello',
        status: 'accepted',
        sentAt: 1_700_000_000_000,
      },
    },
  });

  onTestFinished(() => {
    legacy.stop();
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

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
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
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
  "status": "accepted",
  "sentAt": 1700000000000
}`,
          },
        ],
        structuredContent: {
          message: 'm-legacy',
          session: 's-legacy',
          from: 'tester',
          text: 'hello',
          status: 'accepted',
          sentAt: 1_700_000_000_000,
        },
      },
    },
  });
});

test('it names the registered agents in the spawn tool to a caller holding the read scope', async () => {
  await using ctx = await setupTest();

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      caller: ctx.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      scopes: ['read'],
    },
  );

  expect(JSON.stringify(outcome)).toInclude('the host registered: claude (not installed).');
});

test('it names no agent in the spawn tool to a caller without the read scope', async () => {
  await using ctx = await setupTest();

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      caller: ctx.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      scopes: ['kill'],
    },
  );

  if (outcome.kind !== 'reply') {
    throw new Error('no reply');
  }

  const tools: unknown = getRecord(outcome.body, 'result')['tools'];

  if (!Array.isArray(tools)) {
    throw new TypeError('no tools array');
  }

  const spawn: unknown = tools.find(
    (tool) => isRecord(tool) && tool['name'] === 'atc_session_spawn',
  );

  if (!isRecord(spawn)) {
    throw new Error('atc_session_spawn is not listed');
  }

  const properties = getRecord(getRecord(spawn, 'inputSchema'), 'properties');

  expect({
    tool: spawn['description'],
    agent: getRecord(properties, 'agent')['description'],
  }).toStrictEqual({
    tool: "Spawn a new session in a directory. Optional agent is a registered agent id; omitted agent is the host's default agent (claude when it is registered, else the first registered agent), never the TUI last-used value. atc_agents_list returns the current agents, whether each is installed, and the model and effort each takes. An unregistered agent, a registered agent that is not installed, and a model or effort the agent does not take are refused before anything spawns. Called from inside an atc session, the new session is a sub-session of the caller unless detached is true. Returns the new session descriptor. Give it a prompt to start it working immediately.",
    agent:
      'Registered agent id to spawn; defaults to claude when it is registered, else the first registered agent. atc_agents_list returns the current list.',
  });
});

test('it lists the agents tool without an output schema to match the agents a daemon without spawn options returns', async () => {
  using tmp = setupTempDir('atc-answer-rpc-');

  const legacy = startLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
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

  onTestFinished(() => {
    legacy.stop();
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const [listed, called] = await Promise.all([
    answerRPCRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {
        caller,
        build: 'atc/test-build',
        toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      },
    ),
    answerRPCRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'atc_agents_list', arguments: {} },
      },
      {
        caller,
        build: 'atc/test-build',
        toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      },
    ),
  ]);

  if (listed.kind !== 'reply' || called.kind !== 'reply') {
    throw new Error('no reply');
  }

  const tools: unknown = getRecord(listed.body, 'result')['tools'];

  if (!Array.isArray(tools)) {
    throw new TypeError('no tools array');
  }

  const agentsTool: unknown = tools.find(
    (tool) => isRecord(tool) && tool['name'] === 'atc_agents_list',
  );

  if (!isRecord(agentsTool)) {
    throw new Error('atc_agents_list is not listed');
  }

  expect(agentsTool).not.toContainKey('outputSchema');

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
