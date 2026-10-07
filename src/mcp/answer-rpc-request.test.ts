import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupMCPHTTP } from '../../test/setup-mcp-http';
import { setupTempDir } from '../../test/setup-temp-dir';
import { startLegacyDaemon } from '../../test/start-legacy-daemon';
import { DaemonClient } from '../client/daemon-client';
import { isRecord } from '../shared/report';
import { answerRPCRequest } from './answer-rpc-request';
import { ReconnectingCaller } from './reconnecting-caller';

test('it refuses a tool call whose scope the caller lacks and leaves the session running', async () => {
  await using server = await setupMCPHTTP();

  const spawned = await server.caller.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'claude',
    cols: 80,
    rows: 24,
  });

  const session = spawned['session'];

  if (!isRecord(session) || typeof session['id'] !== 'string') {
    throw new Error('no session in spawn answer');
  }

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_session_kill', arguments: { session: session['id'] } },
    },
    {
      caller: server.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      scopes: ['read', 'message'],
    },
  );

  const listed = await server.caller.sendRequest('session.list');

  expect(outcome).toStrictEqual({ kind: 'forbidden', scope: 'kill' });

  expect(listed).toMatchObject({
    sessions: [expect.objectContaining({ id: session['id'], alive: true })],
  });
});

test('it refuses a forget whose scope the caller lacks and leaves the session listed', async () => {
  await using server = await setupMCPHTTP();

  const spawned = await server.caller.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'claude',
    cols: 80,
    rows: 24,
  });

  const session = spawned['session'];

  if (!isRecord(session) || typeof session['id'] !== 'string') {
    throw new Error('no session in spawn answer');
  }

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'atc_session_forget',
        arguments: { session: session['id'], stop: true },
      },
    },
    {
      caller: server.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      scopes: ['read', 'message', 'spawn'],
    },
  );

  const listed = await server.caller.sendRequest('session.list');

  expect(outcome).toStrictEqual({ kind: 'forbidden', scope: 'kill' });

  expect(listed).toMatchObject({
    sessions: [expect.objectContaining({ id: session['id'], alive: true })],
  });
});

test('it runs a tool call whose scope the caller holds', async () => {
  await using server = await setupMCPHTTP();

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_session_list', arguments: {} },
    },
    {
      caller: server.caller,
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
  await using server = await setupMCPHTTP();

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_events_read', arguments: {} },
    },
    {
      caller: server.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
    },
  );

  if (outcome.kind !== 'reply' || !isRecord(outcome.body['result'])) {
    throw new Error('no tool result');
  }

  const result = outcome.body['result'];
  const content: unknown = Array.isArray(result['content']) ? result['content'][0] : null;

  if (!isRecord(content) || typeof content['text'] !== 'string') {
    throw new Error('no text content');
  }

  expect(result['structuredContent']).toStrictEqual({
    events: [],
    cursor: expect.toBeString(),
    more: false,
  });

  expect(JSON.parse(content['text'])).toStrictEqual(result['structuredContent']);
});

test('it lists every tool to a caller with one scope', async () => {
  await using server = await setupMCPHTTP();

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      caller: server.caller,
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
  await using server = await setupMCPHTTP();

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_unknown_tool', arguments: {} },
    },
    {
      caller: server.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      scopes: ['read', 'message', 'spawn'],
    },
  );

  expect(outcome).toStrictEqual({ kind: 'forbidden', scope: 'kill' });
});

test('it lists the agents to a caller holding only the read scope', async () => {
  await using server = await setupMCPHTTP();

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_agents_list', arguments: {} },
    },
    {
      caller: server.caller,
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

test('it lists the agents tool only when the connected daemon announces it', async () => {
  using tmp = setupTempDir('atc-legacy-rpc-');

  const legacy = startLegacyDaemon(join(tmp.dir, 'daemon.sock'));

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(async () => {
    await caller.stop();

    legacy.stop();
  });

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    {
      caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
    },
  );

  if (outcome.kind !== 'reply' || !isRecord(outcome.body['result'])) {
    throw new Error('no tools/list result');
  }

  const tools: unknown = outcome.body['result']['tools'];

  if (!Array.isArray(tools)) {
    throw new TypeError('no tools array');
  }

  const messageGet: unknown = tools.find(
    (tool) => isRecord(tool) && tool['name'] === 'atc_message_get',
  );

  expect(tools.map((tool) => (isRecord(tool) ? tool['name'] : null))).not.toContain(
    'atc_agents_list',
  );

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
  'it refuses %p with a restart hint when the connected daemon predates it, sending nothing',
  async (name, args) => {
    using tmp = setupTempDir('atc-legacy-rpc-');

    const legacy = startLegacyDaemon(join(tmp.dir, 'daemon.sock'));

    const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
      DaemonClient.open(path),
    );

    onTestFinished(async () => {
      await caller.stop();

      legacy.stop();
    });

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

test('it reads a message from an older daemon when the call asks for no wait', async () => {
  using tmp = setupTempDir('atc-legacy-rpc-');

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

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(async () => {
    await caller.stop();

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
      caller,
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
  await using server = await setupMCPHTTP();

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      caller: server.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      scopes: ['read'],
    },
  );

  const listed = JSON.stringify(outcome);

  expect(listed).toInclude('the host registered: claude (not installed).');
});

test('it names no agent in the spawn tool to a caller without the read scope', async () => {
  await using server = await setupMCPHTTP();

  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      caller: server.caller,
      build: 'atc/test-build',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      scopes: ['kill'],
    },
  );

  expect(JSON.stringify(outcome)).not.toInclude('the host registered');
});

test('it advertises an agents output schema that agrees with what a daemon without spawn options returns', async () => {
  using tmp = setupTempDir('atc-legacy-rpc-');

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

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(async () => {
    await caller.stop();

    legacy.stop();
  });

  const toolContext = {
    callerSessionID: null,
    sender: { kind: 'fixed', name: 'dots' },
  } as const;

  const listed = await answerRPCRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { caller, build: 'atc/test-build', toolContext },
  );

  const called = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'atc_agents_list', arguments: {} },
    },
    { caller, build: 'atc/test-build', toolContext },
  );

  if (listed.kind !== 'reply' || called.kind !== 'reply') {
    throw new Error('expected replies');
  }

  const result = listed.body['result'];
  const tools = isRecord(result) ? result['tools'] : undefined;

  if (!Array.isArray(tools)) {
    throw new TypeError('tools/list returned no tools');
  }

  const agentsTool: unknown = tools.find(
    (tool) => isRecord(tool) && tool['name'] === 'atc_agents_list',
  );

  if (!isRecord(agentsTool)) {
    throw new Error('atc_agents_list is not listed');
  }

  expect(agentsTool).not.toContainKey('outputSchema');

  const content = called.body['result'];
  const structured = isRecord(content) ? content['structuredContent'] : undefined;
  const agents = isRecord(structured) ? structured['agents'] : undefined;

  if (!Array.isArray(agents)) {
    throw new TypeError('atc_agents_list returned no agents');
  }

  expect(agents).toHaveLength(1);
  expect(agents).toSatisfyAll((agent: unknown) => isRecord(agent) && !('spawnOptions' in agent));
});
