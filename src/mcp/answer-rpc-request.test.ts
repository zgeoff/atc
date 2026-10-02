import { expect, test } from 'bun:test';
import { setupMCPHTTP } from '../../test/setup-mcp-http';
import { isRecord } from '../shared/report';
import { answerRPCRequest } from './answer-rpc-request';

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
    body: { result: { tools: expect.toBeArrayOfSize(14) } },
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
