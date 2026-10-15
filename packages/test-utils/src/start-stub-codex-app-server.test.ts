import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from './setup-temp-dir';
import { startStubCodexAppServer } from './start-stub-codex-app-server';
import { waitFor } from './wait-for';

function setupTest() {
  const tmp = setupTempDir('atc-stub-app-server-');
  const socket = join(tmp.dir, 'codex.sock');

  return { socket };
}

test('it completes a turn with the final reply after the message it carries', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { reply: 'all done' });

  onTestFinished(() => server.stop());

  const ws = new WebSocket(`ws+unix://${ctx.socket}`);

  const received: unknown[] = [];

  onTestFinished(() => {
    ws.close();
  });

  ws.addEventListener('message', (e) => {
    received.push(JSON.parse(String(e.data)));
  });

  await new Promise((resolve) => {
    ws.addEventListener('open', resolve, { once: true });
  });

  ws.send(JSON.stringify({ id: 1, method: 'thread/start', params: {} }));

  await waitFor(() => expect(received).toPartiallyContain({ id: 1 }));

  ws.send(
    JSON.stringify({
      id: 2,
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'check the build' }],
        clientUserMessageId: 'm-1',
      },
    }),
  );

  await waitFor(() => expect(received).toPartiallyContain({ method: 'turn/completed' }));

  expect(received).toPartiallyContain({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-2',
        status: 'completed',
        items: [
          { type: 'userMessage', id: 'item-3', text: 'check the build', clientId: 'm-1' },
          { type: 'agentMessage', id: 'item-4', text: 'all done', phase: 'final_answer' },
        ],
      },
    },
  });
});

test('it adds a second message to the turn in progress', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { holdTurns: true });

  onTestFinished(() => server.stop());

  const ws = new WebSocket(`ws+unix://${ctx.socket}`);

  const received: unknown[] = [];

  onTestFinished(() => {
    ws.close();
  });

  ws.addEventListener('message', (e) => {
    received.push(JSON.parse(String(e.data)));
  });

  await new Promise((resolve) => {
    ws.addEventListener('open', resolve, { once: true });
  });

  ws.send(JSON.stringify({ id: 1, method: 'thread/start', params: {} }));

  for (const [id, text] of [
    [2, 'one'],
    [3, 'two'],
  ] as const) {
    ws.send(
      JSON.stringify({
        id,
        method: 'turn/start',
        params: { threadId: 'thread-1', input: [{ type: 'text', text }] },
      }),
    );
  }

  await waitFor(() => expect(received).toPartiallyContain({ id: 3 }));

  expect(received).toIncludeAllPartialMembers([
    { id: 2, result: { turn: { id: 'turn-2', status: 'inProgress', items: [] } } },
    { id: 3, result: { turn: { id: 'turn-2', status: 'inProgress', items: [] } } },
  ]);
});

test('it completes a held turn before it answers a resume, when the scenario asks', async () => {
  const ctx = setupTest();

  const server = startStubCodexAppServer(ctx.socket, {
    holdTurns: true,
    completeHeldTurnsOnResume: true,
  });

  onTestFinished(() => server.stop());

  const ws = new WebSocket(`ws+unix://${ctx.socket}`);

  const received: { readonly id?: unknown; readonly method?: unknown }[] = [];

  onTestFinished(() => {
    ws.close();
  });

  ws.addEventListener('message', (e) => {
    received.push(JSON.parse(String(e.data)));
  });

  await new Promise((resolve) => {
    ws.addEventListener('open', resolve, { once: true });
  });

  ws.send(JSON.stringify({ id: 1, method: 'thread/start', params: {} }));

  ws.send(
    JSON.stringify({
      id: 2,
      method: 'turn/start',
      params: { threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] },
    }),
  );

  ws.send(JSON.stringify({ id: 3, method: 'thread/resume', params: { threadId: 'thread-1' } }));

  await waitFor(() => expect(received).toPartiallyContain({ id: 3 }));

  const completedAt = received.findIndex((m) => m.method === 'turn/completed');
  const resumedAt = received.findIndex((m) => m.id === 3);

  expect(completedAt).toBeWithin(0, resumedAt);
});

test('it fails every history read from the connection the scenario names', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { failTurnsListFrom: 1 });

  onTestFinished(() => server.stop());

  const ws = new WebSocket(`ws+unix://${ctx.socket}`);

  const received: unknown[] = [];

  onTestFinished(() => {
    ws.close();
  });

  ws.addEventListener('message', (e) => {
    received.push(JSON.parse(String(e.data)));
  });

  await new Promise((resolve) => {
    ws.addEventListener('open', resolve, { once: true });
  });

  ws.send(JSON.stringify({ id: 1, method: 'thread/start', params: {} }));
  ws.send(JSON.stringify({ id: 2, method: 'thread/turns/list', params: { threadId: 'thread-1' } }));

  await waitFor(() => expect(received).toPartiallyContain({ id: 2 }));

  expect(received).toPartiallyContain({
    id: 2,
    error: { code: -32_603, message: 'failed to read thread history' },
  });
});

test('it lists turns newest first, a page at a time', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, {});

  onTestFinished(() => server.stop());

  const ws = new WebSocket(`ws+unix://${ctx.socket}`);

  const received: unknown[] = [];

  onTestFinished(() => {
    ws.close();
  });

  ws.addEventListener('message', (e) => {
    received.push(JSON.parse(String(e.data)));
  });

  await new Promise((resolve) => {
    ws.addEventListener('open', resolve, { once: true });
  });

  ws.send(JSON.stringify({ id: 1, method: 'thread/start', params: {} }));

  for (const id of [2, 3]) {
    ws.send(
      JSON.stringify({
        id,
        method: 'turn/start',
        params: { threadId: 'thread-1', input: [{ type: 'text', text: `turn ${id}` }] },
      }),
    );
  }

  ws.send(
    JSON.stringify({
      id: 4,
      method: 'thread/turns/list',
      params: { threadId: 'thread-1', limit: 1, cursor: '1' },
    }),
  );

  await waitFor(() => expect(received).toPartiallyContain({ id: 4 }));

  expect(received).toPartiallyContain({
    id: 4,
    result: { data: [expect.objectContaining({ id: 'turn-2' })], nextCursor: null },
  });
});

test('it refuses a request for a thread it does not hold', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, {});

  onTestFinished(() => server.stop());

  const ws = new WebSocket(`ws+unix://${ctx.socket}`);

  const received: unknown[] = [];

  onTestFinished(() => {
    ws.close();
  });

  ws.addEventListener('message', (e) => {
    received.push(JSON.parse(String(e.data)));
  });

  await new Promise((resolve) => {
    ws.addEventListener('open', resolve, { once: true });
  });

  ws.send(JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'missing' } }));

  await waitFor(() => expect(received).toPartiallyContain({ id: 1 }));

  expect(received).toPartiallyContain({
    id: 1,
    error: { code: -32_600, message: 'thread not loaded' },
  });
});

test('it closes the connection in place of the answer to the turn start the scenario names', async () => {
  const ctx = setupTest();

  const server = startStubCodexAppServer(ctx.socket, {
    holdTurns: true,
    dropOnTurnStart: 1,
  });

  onTestFinished(() => server.stop());

  const ws = new WebSocket(`ws+unix://${ctx.socket}`);

  const closed = new Promise((resolve) => {
    ws.addEventListener('close', resolve, { once: true });
  });

  await new Promise((resolve) => {
    ws.addEventListener('open', resolve, { once: true });
  });

  ws.send(JSON.stringify({ id: 1, method: 'thread/start', params: {} }));

  ws.send(
    JSON.stringify({
      id: 2,
      method: 'turn/start',
      params: { threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] },
    }),
  );

  await expect(closed).toResolve();
});

test('it records each request and hands it to the listener', async () => {
  const ctx = setupTest();
  const seen: unknown[] = [];

  const server = startStubCodexAppServer(ctx.socket, {}, (request) => {
    seen.push(request);
  });

  onTestFinished(() => server.stop());

  const ws = new WebSocket(`ws+unix://${ctx.socket}`);

  onTestFinished(() => {
    ws.close();
  });

  await new Promise((resolve) => {
    ws.addEventListener('open', resolve, { once: true });
  });

  ws.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: {} } }));

  await waitFor(() => expect(server.requests).toHaveLength(1));

  expect(server.requests).toStrictEqual([{ method: 'initialize', params: { clientInfo: {} } }]);
  expect(seen).toStrictEqual([{ method: 'initialize', params: { clientInfo: {} } }]);
});

test('it resolves a tool call with the result the client answers', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { holdTurns: true });

  onTestFinished(() => server.stop());

  const ws = new WebSocket(`ws+unix://${ctx.socket}`);

  const received: { readonly id?: unknown; readonly method?: unknown }[] = [];

  onTestFinished(() => {
    ws.close();
  });

  ws.addEventListener('message', (e) => {
    const message = JSON.parse(String(e.data));

    received.push(message);

    if (message.method === 'item/tool/call') {
      ws.send(JSON.stringify({ id: message.id, result: { success: true, contentItems: [] } }));
    }
  });

  await new Promise((resolve) => {
    ws.addEventListener('open', resolve, { once: true });
  });

  ws.send(JSON.stringify({ id: 1, method: 'thread/start', params: {} }));

  ws.send(
    JSON.stringify({
      id: 2,
      method: 'turn/start',
      params: { threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] },
    }),
  );

  await waitFor(() => expect(received).toPartiallyContain({ id: 2 }));

  const result = await server.callTool('note', { text: 'halfway' });

  expect(result).toStrictEqual({ success: true, contentItems: [] });

  expect(received).toPartiallyContain({
    method: 'item/tool/call',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-2',
      callId: expect.any(String),
      namespace: 'atc',
      tool: 'note',
      arguments: { text: 'halfway' },
    },
  });
});

test('it answers history reads on a connection before the one the scenario names', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { failTurnsListFrom: 2 });

  onTestFinished(() => server.stop());

  const ws = new WebSocket(`ws+unix://${ctx.socket}`);

  const received: unknown[] = [];

  onTestFinished(() => {
    ws.close();
  });

  ws.addEventListener('message', (e) => {
    received.push(JSON.parse(String(e.data)));
  });

  await new Promise((resolve) => {
    ws.addEventListener('open', resolve, { once: true });
  });

  ws.send(JSON.stringify({ id: 1, method: 'thread/start', params: {} }));
  ws.send(JSON.stringify({ id: 2, method: 'thread/turns/list', params: { threadId: 'thread-1' } }));

  await waitFor(() => expect(received).toPartiallyContain({ id: 2 }));

  expect(received).toPartiallyContain({ id: 2, result: { data: [], nextCursor: null } });
});
