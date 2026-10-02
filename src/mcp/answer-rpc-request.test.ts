import { expect, test } from 'bun:test';
import { answerRPCRequest } from './answer-rpc-request';

test('it refuses a tool call whose scope the caller lacks without calling the daemon', async () => {
  const sent: string[] = [];

  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_session_kill', arguments: { session: 's1' } },
    },
    {
      caller: {
        sendRequest: (m) => {
          sent.push(m);

          return Promise.resolve({});
        },
      },
      build: 'atc/test',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      scopes: ['read', 'message'],
    },
  );

  expect(outcome).toStrictEqual({ kind: 'forbidden', scope: 'kill' });
  expect(sent).toStrictEqual([]);
});

test('it runs a tool call whose scope the caller holds', async () => {
  const outcome = await answerRPCRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_session_list', arguments: {} },
    },
    {
      caller: { sendRequest: () => Promise.resolve({ sessions: [] }) },
      build: 'atc/test',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      scopes: ['read'],
    },
  );

  expect(outcome).toStrictEqual({
    kind: 'reply',
    body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '[]' }] } },
  });
});

test('it lists every tool to a caller with one scope', async () => {
  const outcome = await answerRPCRequest(
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      caller: { sendRequest: () => Promise.resolve({}) },
      build: 'atc/test',
      toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
      scopes: ['read'],
    },
  );

  expect(outcome).toMatchObject({
    kind: 'reply',
    body: { result: { tools: expect.toBeArrayOfSize(14) } },
  });
});
