import { expect, onTestFinished, test } from 'bun:test';
import { DaemonClient } from '../client/daemon-client';
import { getRecord } from '../shared/get-record';
import { isRecord } from '../shared/report';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { startLegacyDaemon } from '../test-utils/start-legacy-daemon';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { answerRPCRequest } from './answer-rpc-request';
import { ReconnectingCaller } from './reconnecting-caller';

// A real daemon whose one agent is a `claude` that is not installed and
// whose sessions run `sleep`, and `atc mcp`'s caller in front of it, which
// connects on its first request.
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

  const owned = stack.move();

  return {
    daemon,
    caller,
    dir: daemon.dir,
    socketPath: daemon.socketPath,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it refuses a tool call whose scope the caller lacks and leaves the session running', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'claude',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_session_kill', arguments: { session: id } },
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
    sessions: [expect.objectContaining({ id, alive: true })],
  });
});

test('it refuses a forget whose scope the caller lacks and leaves the session listed', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'claude',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_session_forget', arguments: { session: id, stop: true } },
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
    sessions: [expect.objectContaining({ id, alive: true })],
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

  expect(outcome).toStrictEqual({
    kind: 'reply',
    body: {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: '[]' }],
        structuredContent: { sessions: [] },
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
  await using ctx = await setupTest();

  await ctx.daemon.stop();

  const legacy = startLegacyDaemon(ctx.socketPath);

  onTestFinished(() => {
    legacy.stop();
  });

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    {
      caller: ctx.caller,
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
  await using ctx = await setupTest();

  await ctx.daemon.stop();

  const legacy = startLegacyDaemon(ctx.socketPath);

  onTestFinished(() => {
    legacy.stop();
  });

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    {
      caller: ctx.caller,
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
  ['atc_session_spawn', { cwd: '/tmp', model: 'opus' }],
  ['atc_session_spawn', { cwd: '/tmp', effort: 'high' }],
])(
  'it refuses %p called with %p with a restart hint when the connected daemon predates it, sending nothing',
  async (name, args) => {
    await using ctx = await setupTest();

    await ctx.daemon.stop();

    const legacy = startLegacyDaemon(ctx.socketPath);

    onTestFinished(() => {
      legacy.stop();
    });

    const outcome = await answerRPCRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      {
        caller: ctx.caller,
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
  await using ctx = await setupTest();

  await ctx.daemon.stop();

  const legacy = startLegacyDaemon(ctx.socketPath, {
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

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_message_get', arguments: { message: 'm-legacy' } },
    },
    {
      caller: ctx.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
    },
  );

  expect(outcome).toMatchObject({
    kind: 'reply',
    body: { result: { structuredContent: { message: 'm-legacy', status: 'accepted' } } },
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

  expect(JSON.stringify(outcome)).not.toInclude('the host registered');
});

test('it lists the agents tool without an output schema when the connected daemon predates spawn options', async () => {
  await using ctx = await setupTest();

  await ctx.daemon.stop();

  const legacy = startLegacyDaemon(ctx.socketPath, {
    features: ['agents.list', 'events.more', 'events.session', 'message.turn', 'message.wait'],
  });

  onTestFinished(() => {
    legacy.stop();
  });

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    {
      caller: ctx.caller,
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

  const agentsTool: unknown = tools.find(
    (tool) => isRecord(tool) && tool['name'] === 'atc_agents_list',
  );

  if (!isRecord(agentsTool)) {
    throw new Error('atc_agents_list is not listed');
  }

  expect(agentsTool).not.toContainKey('outputSchema');
});

test('it returns the agents a daemon without spawn options lists, without spawn options', async () => {
  await using ctx = await setupTest();

  await ctx.daemon.stop();

  const legacy = startLegacyDaemon(ctx.socketPath, {
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

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'atc_agents_list', arguments: {} },
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

  expect(getRecord(getRecord(outcome.body, 'result'), 'structuredContent')['agents']).toStrictEqual(
    [
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
  );
});
