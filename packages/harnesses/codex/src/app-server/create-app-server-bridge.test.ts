import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import {
  buildStubMessageBridgeHost,
  setupTempDir,
  startCodexTerminalThread,
  startStubCodexAppServer,
  waitFor,
} from '@atc/test-utils';
import { AppServerError } from './app-server-error';
import { createAppServerBridge } from './create-app-server-bridge';
import { createAppServerConnection } from './create-app-server-connection';
import type { AppServerConnection, AppServerNotification } from './create-app-server-connection';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-app-server-bridge-');
  const socket = join(temporaryDirectory.path, 'codex.sock');

  return {
    socket,
    unconfirmedFile: join(temporaryDirectory.path, 'unconfirmed-sends.json'),
    openConnection: () => createAppServerConnection(`ws+unix://${socket}`),
  };
}

test('it delivers a queued message with turn/start and answers it with the turn reply', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { reply: 'the build passes' });
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('answered');
  });

  expect(server.requests).toPartiallyContain({
    method: 'turn/start',
    params: {
      threadId: 'thread-1',
      input: [
        {
          type: 'text',
          text: '<atc-message id="m-1" from="planner">\ncheck the build\n</atc-message>',
          text_elements: [],
        },
      ],
      clientUserMessageId: 'm-1',
    },
  });

  expect(stub.notes).toStrictEqual([
    { kind: 'answered', messages: ['m-1'], answer: 'the build passes', turn: 'turn-2' },
  ]);
});

test('it starts the thread with the atc tools and writes its rollout before it resolves', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, {});
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
  });

  onTestFinished(() => {
    bridge.stop();
  });

  const thread = await bridge.open();

  expect(thread).toBe('thread-1');

  expect(server.requests.map((request) => request.method)).toStrictEqual([
    'initialize',
    'thread/start',
    'thread/inject_items',
  ]);
});

test('it starts a new thread when the thread it was given does not resume', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, {});
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: 'gone-thread',
  });

  onTestFinished(() => {
    bridge.stop();
  });

  const thread = await bridge.open();

  expect(thread).toBe('thread-1');
});

test('it keeps every stored message as it was and sends nothing when the history read fails', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { failTurnsListFrom: 1 });

  const stub = buildStubMessageBridgeHost([
    { id: 'm-accepted', status: 'delivered' },
    { id: 'm-waiting', status: 'queued' },
  ]);

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
    retryMs: { first: 10, max: 20 },
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();

  await waitFor(() => {
    expect(
      server.requests.filter((request) => request.method === 'thread/turns/list').length,
    ).toBeGreaterThan(2);
  });

  expect([...stub.statuses]).toStrictEqual([
    ['m-accepted', 'delivered'],
    ['m-waiting', 'queued'],
  ]);

  expect(server.requests).not.toPartiallyContain({ method: 'turn/start' });
  expect(stub.attaches).toBe(0);
  expect(stub.notes).toStrictEqual([]);
});

test('it resends no accepted message when its turn completes while the connection is set up', async () => {
  const ctx = setupTest();

  const server = startStubCodexAppServer(ctx.socket, {
    reply: 'answered once',
    holdTurns: true,
    dropOnTurnStart: 1,
    completeHeldTurnsOnResume: true,
  });

  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
    retryMs: { first: 10, max: 20 },
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('answered');
  });

  await waitFor(() => {
    expect(stub.attaches).toBe(2);
  });

  expect(server.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);

  expect(stub.notes).toStrictEqual([
    { kind: 'answered', messages: ['m-1'], answer: 'answered once', turn: 'turn-2' },
  ]);
});

test('it settles a message the server took before the daemon marked it, and sends it no more', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { reply: 'done earlier' });
  const first = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const earlier = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: first.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
  });

  onTestFinished(() => {
    earlier.stop();
  });

  const thread = await earlier.open();

  earlier.startDelivery();
  first.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await waitFor(() => {
    expect(first.statuses.get('m-1')).toBe('answered');
  });

  earlier.stop();

  const stub = buildStubMessageBridgeHost([{ id: 'm-1', status: 'queued' }]);

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: thread,
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('answered');
  });

  expect(server.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);

  expect(stub.notes).toStrictEqual([
    { kind: 'answered', messages: ['m-1'], answer: 'done earlier', turn: 'turn-2' },
  ]);
});

test('it leaves a delivered message that no stored turn holds unanswered as never started', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, {});
  const stub = buildStubMessageBridgeHost([{ id: 'm-lost', status: 'delivered' }]);

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();

  await waitFor(() => {
    expect(stub.statuses.get('m-lost')).toBe('unanswered');
  });

  expect(stub.notes).toStrictEqual([
    { kind: 'unanswered', messages: ['m-lost'], reason: 'not_started' },
  ]);
});

test('it records a note the model calls atc.note with', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { holdTurns: true });
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('delivered');
  });

  const result = await server.callTool('note', { text: 'found the cause', label: 'decision' });

  expect(result).toStrictEqual({
    success: true,
    contentItems: [{ type: 'inputText', text: 'Handed to atc for its event feed.' }],
  });

  expect(stub.notes).toStrictEqual([{ kind: 'note', label: 'decision', text: 'found the cause' }]);
});

test('it answers a message the running turn carries through atc.answer', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { holdTurns: true });
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('delivered');
  });

  const result = await server.callTool('answer', { message: 'm-1', text: 'it passes' });

  expect(result).toMatchObject({ success: true });

  expect(stub.notes).toStrictEqual([
    { kind: 'answered', message: 'm-1', answer: 'it passes', turn: 'turn-2' },
  ]);
});

test('it answers an atc.answer that a resumed thread calls before its recovery ends', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { holdTurns: true });
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const before = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
  });

  onTestFinished(() => {
    before.stop();
  });

  await before.open();

  before.startDelivery();
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('delivered');
  });

  before.stop();

  const recovery = Promise.withResolvers<undefined>();

  const after = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: {
      ...stub.host,
      readUnsettledMessages: async () => {
        await recovery.promise;

        return stub.host.readUnsettledMessages();
      },
    },
    openConnection: ctx.openConnection,
    resumeThread: 'thread-1',
  });

  onTestFinished(() => {
    after.stop();
  });

  await after.open();

  after.startDelivery();

  const answered = server.callTool('answer', { message: 'm-1', text: 'it passes' });

  recovery.resolve(undefined);

  const result = await answered;

  expect(result).toMatchObject({ success: true });

  expect(stub.notes).toStrictEqual([
    { kind: 'answered', message: 'm-1', answer: 'it passes', turn: 'turn-2' },
  ]);
});

test('it refuses an atc.answer for a message the running turn does not carry', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { holdTurns: true });
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('delivered');
  });

  const result = await server.callTool('answer', { message: 'm-other', text: 'it passes' });

  expect(result).toStrictEqual({
    success: false,
    contentItems: [{ type: 'inputText', text: 'the running turn carries no message m-other' }],
  });

  expect(stub.notes).toStrictEqual([]);
});

test('it closes a connection that opens after the bridge stopped, and uses it for nothing', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, {});
  const stub = buildStubMessageBridgeHost();
  const opening = Promise.withResolvers<AppServerConnection>();
  let opened: AppServerConnection | null = null;

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: () => opening.promise,
    resumeThread: null,
  });

  const open = bridge.open();

  bridge.stop();

  opened = await ctx.openConnection();

  opening.resolve(opened);

  expect(open).rejects.toMatchObject({ code: -1 });

  await waitFor(() => {
    expect(opened?.isOpen).toBe(false);
  });

  expect(server.requests).toStrictEqual([]);
});

test('it leaves a message the App Server refuses unanswered and keeps the connection', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { rejectTurnStarts: true });
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
    retryMs: { first: 10, max: 20 },
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });
  stub.queueMessage({ id: 'm-2', from: 'planner', text: 'and the lint' });

  await waitFor(() => {
    expect(stub.statuses.get('m-2')).toBe('unanswered');
  });

  expect(stub.statuses.get('m-1')).toBe('unanswered');

  expect(stub.notes).toStrictEqual([
    { kind: 'unanswered', messages: ['m-1'], reason: 'error' },
    { kind: 'unanswered', messages: ['m-2'], reason: 'error' },
  ]);

  expect(server.requests.filter((request) => request.method === 'initialize')).toHaveLength(1);
});

test('it keeps a message the overloaded App Server turns away queued and delivers it on a later send', async () => {
  const ctx = setupTest();
  const stub = buildStubMessageBridgeHost();
  const statusesAtSend: (string | undefined)[] = [];

  const server = startStubCodexAppServer(
    ctx.socket,
    { overloadTurnStarts: 2, reply: 'the build passes' },
    (request) => {
      if (request.method === 'turn/start') {
        statusesAtSend.push(stub.statuses.get('m-1'));
      }
    },
  );

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
    retryMs: { first: 10, max: 20 },
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('answered');
  });

  expect(statusesAtSend).toStrictEqual(['queued', 'queued', 'queued']);

  expect(stub.notes).toStrictEqual([
    { kind: 'answered', messages: ['m-1'], answer: 'the build passes', turn: 'turn-2' },
  ]);

  expect(server.requests.filter((request) => request.method === 'initialize')).toHaveLength(1);
});

test('it sends a message the daemon hands over during an overload wait only after the overloaded one', async () => {
  const ctx = setupTest();
  const stub = buildStubMessageBridgeHost();
  let queuedSecond = false;

  // The daemon hands a new message over as soon as it is queued, even while
  // the tap still holds the overloaded one.
  const server = startStubCodexAppServer(ctx.socket, { overloadTurnStarts: 1 }, (request) => {
    if (request.method === 'turn/start' && !queuedSecond) {
      queuedSecond = true;

      stub.queueMessage({ id: 'm-2', from: 'planner', text: 'and the lint' });
    }
  });

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
    retryMs: { first: 10, max: 20 },
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await waitFor(() => {
    expect(stub.statuses.get('m-2')).toBe('answered');
  });

  expect(stub.statuses.get('m-1')).toBe('answered');

  expect(server.requests.filter((request) => request.method === 'turn/start')).toMatchObject([
    { params: { clientUserMessageId: 'm-1' } },
    { params: { clientUserMessageId: 'm-1' } },
    { params: { clientUserMessageId: 'm-2' } },
  ]);
});

test('it moves to the thread the terminal shows without waiting out an overload', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { overloadTurnStarts: 1000 });
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
    retryMs: { first: 10, max: 20 },
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await waitFor(() => {
    expect(server.requests).toPartiallyContain({ method: 'turn/start' });
  });

  const moved = await startCodexTerminalThread(ctx.socket);

  bridge.updateThread(moved);

  await waitFor(() => {
    expect(server.requests.findLast((request) => request.method === 'turn/start')).toMatchObject({
      params: { threadId: moved, clientUserMessageId: 'm-1' },
    });
  });

  expect(server.requests.filter((request) => request.method === 'thread/resume')).toMatchObject([
    { params: { threadId: moved } },
  ]);

  expect(stub.statuses.get('m-1')).toBe('queued');
});

test('it moves when the terminal moves while an overloaded send waits for its answer, and retries nothing on the old thread', async () => {
  const ctx = setupTest();
  const taken = Promise.withResolvers<undefined>();
  const answer = Promise.withResolvers<undefined>();

  const server = startStubCodexAppServer(
    ctx.socket,
    { overloadTurnStarts: 2, reply: 'the docs build' },
    (request) => {
      if (request.method === 'turn/start') {
        taken.resolve(undefined);
      }
    },
  );

  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  // The bridge sees the overload answer to its first turn/start only once
  // the test lets it through, after the terminal moved.
  let held = false;

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: async () => {
      const conn = await ctx.openConnection();

      const sendRequest = conn.sendRequest.bind(conn);

      conn.sendRequest = async (method, params) => {
        const pending = sendRequest(method, params);

        if (method === 'turn/start' && !held) {
          held = true;

          await Promise.allSettled([pending, answer.promise]);
        }

        return pending;
      };

      return conn;
    },
    resumeThread: null,
    retryMs: { first: 10, max: 20 },
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'build the docs' });

  await taken.promise;

  stub.queueMessage({ id: 'm-2', from: 'planner', text: 'and the changelog' });

  const moved = await startCodexTerminalThread(ctx.socket);

  bridge.updateThread(moved);
  answer.resolve(undefined);

  await waitFor(() => {
    expect(stub.statuses.get('m-2')).toBe('answered');
  });

  expect(stub.statuses.get('m-1')).toBe('answered');

  expect(server.requests.filter((request) => request.method === 'thread/resume')).toMatchObject([
    { params: { threadId: moved } },
  ]);

  expect(server.requests.filter((request) => request.method === 'turn/start')).toMatchObject([
    { params: { threadId: 'thread-1', clientUserMessageId: 'm-1' } },
    { params: { threadId: moved, clientUserMessageId: 'm-1' } },
    { params: { threadId: moved, clientUserMessageId: 'm-1' } },
    { params: { threadId: moved, clientUserMessageId: 'm-2' } },
  ]);
});

test('it keeps a notice the overloaded App Server turns away queued and delivers it on a later send', async () => {
  const ctx = setupTest();
  const stub = buildStubMessageBridgeHost();
  const statusesAtSend: (string | undefined)[] = [];

  const server = startStubCodexAppServer(ctx.socket, { overloadTurnStarts: 2 }, (request) => {
    if (request.method === 'turn/start') {
      statusesAtSend.push(stub.noticeStatuses.get('m-0'));
    }
  });

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
    retryMs: { first: 10, max: 20 },
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();
  stub.queueNotice({ id: 'm-0', from: 'reviewer', status: 'answered', answer: 'looks fine' });

  await waitFor(() => {
    expect(stub.noticeStatuses.get('m-0')).toBe('delivered');
  });

  expect(statusesAtSend).toStrictEqual(['queued', 'queued', 'queued']);

  expect(
    server.requests.filter(
      (request) =>
        request.method === 'turn/start' && JSON.stringify(request.params).includes('"notice:m-0"'),
    ),
  ).toHaveLength(3);
});

test('it starts the thread and each turn on the model the spawn asked for', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, {});
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
    model: 'gpt-test-large',
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('answered');
  });

  expect(
    server.requests.find((request) => request.method === 'thread/start')?.params,
  ).toMatchObject({
    model: 'gpt-test-large',
  });

  expect(server.requests.find((request) => request.method === 'turn/start')?.params).toMatchObject({
    clientUserMessageId: 'm-1',
    model: 'gpt-test-large',
  });
});

test('it resumes the thread it was given on the model the spawn asked for', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, {});

  onTestFinished(() => server.stop());

  const thread = await startCodexTerminalThread(ctx.socket);

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: buildStubMessageBridgeHost().host,
    openConnection: ctx.openConnection,
    resumeThread: thread,
    model: 'gpt-test-large',
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  expect(
    server.requests.find((request) => request.method === 'thread/resume')?.params,
  ).toMatchObject({
    threadId: thread,
    model: 'gpt-test-large',
  });
});

test('it leaves the model to the server when the spawn asked for none', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, {});
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('answered');
  });

  expect(
    server.requests.filter((request) => JSON.stringify(request.params).includes('"model"')),
  ).toStrictEqual([]);
});

test('it delivers a message to the thread the terminal moved to and none to the old one', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { reply: 'the lint is clean' });
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
    retryMs: { first: 10, max: 50 },
  });

  onTestFinished(() => {
    bridge.stop();
  });

  const first = await bridge.open();

  bridge.startDelivery();

  const moved = await startCodexTerminalThread(ctx.socket);

  bridge.updateThread(moved);
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'run the lint' });

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('answered');
  });

  const turnStarts = server.requests.filter((request) => request.method === 'turn/start');

  expect(first).not.toBe(moved);
  expect(turnStarts).toMatchObject([{ params: { threadId: moved, clientUserMessageId: 'm-1' } }]);

  expect(server.requests.filter((request) => request.method === 'thread/resume')).toMatchObject([
    { params: { threadId: moved } },
  ]);

  expect(stub.notes).toStrictEqual([
    { kind: 'answered', messages: ['m-1'], answer: 'the lint is clean', turn: expect.any(String) },
  ]);
});

test('it leaves a message unanswered and sends it nowhere else when the terminal moves while its turn runs', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { holdTurns: true });
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
    retryMs: { first: 10, max: 50 },
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('delivered');
  });

  const moved = await startCodexTerminalThread(ctx.socket);

  bridge.updateThread(moved);

  await waitFor(() => {
    expect(stub.attaches).toBe(2);
  });

  expect(stub.statuses.get('m-1')).toBe('unanswered');

  expect(stub.notes).toStrictEqual([
    { kind: 'unanswered', messages: ['m-1'], reason: 'thread_switched' },
  ]);

  expect(server.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
});

test('it changes nothing when the thread it is given is the one it serves', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, {});
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
  });

  onTestFinished(() => {
    bridge.stop();
  });

  const thread = await bridge.open();

  bridge.startDelivery();

  await waitFor(() => {
    expect(stub.attaches).toBe(1);
  });

  bridge.updateThread(thread);
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('answered');
  });

  expect(stub.attaches).toBe(1);
  expect(server.requests.map((request) => request.method)).not.toContain('thread/resume');
});

test('it sends a message the old thread took nowhere else when the terminal moves before the answer to its send', async () => {
  const ctx = setupTest();
  const taken = Promise.withResolvers<undefined>();
  const answer = Promise.withResolvers<undefined>();

  const server = startStubCodexAppServer(ctx.socket, { holdTurns: true }, (request) => {
    if (request.method === 'turn/start') {
      taken.resolve(undefined);
    }
  });

  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  // The bridge sees the answer to its first turn/start, and every
  // notification after it, only once the test lets them through, after the
  // server took the message.
  let held = false;

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: async () => {
      const conn = await ctx.openConnection();

      const sendRequest = conn.sendRequest.bind(conn);
      let onNotification = conn.onNotification;

      Object.defineProperty(conn, 'onNotification', {
        // oxlint-disable-next-line zgeoff/verb-contract -- a property descriptor names its accessor get
        get: () => (notification: AppServerNotification) => {
          void (async () => {
            if (held) {
              await answer.promise;
            }

            onNotification(notification);
          })();
        },
        set: (listener: (notification: AppServerNotification) => void) => {
          onNotification = listener;
        },
      });

      const dispose = conn.dispose.bind(conn);
      let disposed = false;

      conn.dispose = () => {
        disposed = true;

        dispose();
      };

      conn.sendRequest = async (method, params) => {
        const pending = sendRequest(method, params);

        if (method === 'turn/start' && !held) {
          held = true;

          await Promise.allSettled([pending, answer.promise]);

          // An answer held past the connection's close never arrives.
          if (disposed) {
            throw new AppServerError(-1, 'the connection closed');
          }
        }

        return pending;
      };

      return conn;
    },
    resumeThread: null,
    retryMs: { first: 10, max: 50 },
  });

  onTestFinished(() => {
    bridge.stop();
  });

  await bridge.open();

  bridge.startDelivery();
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await taken.promise;

  const moved = await startCodexTerminalThread(ctx.socket);

  bridge.updateThread(moved);
  answer.resolve(undefined);

  await waitFor(() => {
    expect(stub.attaches).toBe(2);
  });

  expect(stub.statuses.get('m-1')).toBe('unanswered');

  expect(stub.notes).toStrictEqual([
    { kind: 'unanswered', messages: ['m-1'], reason: 'thread_switched' },
  ]);

  expect(server.requests.filter((request) => request.method === 'turn/start')).toMatchObject([
    { params: { threadId: 'thread-1', clientUserMessageId: 'm-1' } },
  ]);
});

test('it sends a message the old thread took nowhere else when the connection drops before the answer to its send and the terminal moves before the reconnect', async () => {
  const ctx = setupTest();
  const taken = Promise.withResolvers<undefined>();

  const server = startStubCodexAppServer(
    ctx.socket,
    { holdTurns: true, dropOnTurnStart: 1 },
    (request) => {
      if (request.method === 'turn/start') {
        taken.resolve(undefined);
      }
    },
  );

  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
    retryMs: { first: 10, max: 50 },
  });

  onTestFinished(() => {
    bridge.stop();
  });

  const first = await bridge.open();

  bridge.startDelivery();

  const moved = await startCodexTerminalThread(ctx.socket);

  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await taken.promise;

  bridge.updateThread(moved);

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('unanswered');
  });

  expect(stub.notes).toStrictEqual([
    { kind: 'unanswered', messages: ['m-1'], reason: 'thread_switched' },
  ]);

  expect(server.requests.filter((request) => request.method === 'turn/start')).toMatchObject([
    { params: { threadId: first, clientUserMessageId: 'm-1' } },
  ]);

  expect(server.requests.filter((request) => request.method === 'thread/turns/list')).toMatchObject(
    [{ params: { threadId: first } }],
  );
});

test('it sends a message the old thread took nowhere else when the daemon restarts on the thread the terminal moved to before the reconnect', async () => {
  const ctx = setupTest();
  const taken = Promise.withResolvers<undefined>();

  const server = startStubCodexAppServer(
    ctx.socket,
    { holdTurns: true, dropOnTurnStart: 1 },
    (request) => {
      if (request.method === 'turn/start') {
        taken.resolve(undefined);
      }
    },
  );

  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const before = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
    unconfirmedFile: ctx.unconfirmedFile,
    retryMs: { first: 60_000, max: 60_000 },
  });

  onTestFinished(() => {
    before.stop();
  });

  const first = await before.open();

  before.startDelivery();

  const moved = await startCodexTerminalThread(ctx.socket);

  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await taken.promise;

  await waitFor(() => {
    expect(stub.logs).toContainEqual(expect.toInclude('message m-1 stayed queued'));
  });

  before.stop();

  const after = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: moved,
    unconfirmedFile: ctx.unconfirmedFile,
    retryMs: { first: 10, max: 50 },
  });

  onTestFinished(() => {
    after.stop();
  });

  await after.open();

  after.startDelivery();

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('unanswered');
  });

  expect(stub.notes).toStrictEqual([
    { kind: 'unanswered', messages: ['m-1'], reason: 'thread_switched' },
  ]);

  expect(server.requests.filter((request) => request.method === 'turn/start')).toMatchObject([
    { params: { threadId: first, clientUserMessageId: 'm-1' } },
  ]);

  expect(server.requests.filter((request) => request.method === 'thread/turns/list')).toMatchObject(
    [{ params: { threadId: first } }],
  );
});

test('it delivers a message the old thread never took to the thread the terminal moved to when the connection drops before the answer to its send', async () => {
  const ctx = setupTest();
  const taken = Promise.withResolvers<undefined>();

  const server = startStubCodexAppServer(
    ctx.socket,
    { reply: 'the lint is clean', dropBeforeTurnStart: 1 },
    (request) => {
      if (request.method === 'turn/start') {
        taken.resolve(undefined);
      }
    },
  );

  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
    retryMs: { first: 10, max: 50 },
  });

  onTestFinished(() => {
    bridge.stop();
  });

  const first = await bridge.open();

  bridge.startDelivery();

  const moved = await startCodexTerminalThread(ctx.socket);

  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'run the lint' });

  await taken.promise;

  bridge.updateThread(moved);

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('answered');
  });

  expect(stub.notes).toStrictEqual([
    { kind: 'answered', messages: ['m-1'], answer: 'the lint is clean', turn: expect.any(String) },
  ]);

  expect(server.requests.filter((request) => request.method === 'turn/start')).toMatchObject([
    { params: { threadId: first, clientUserMessageId: 'm-1' } },
    { params: { threadId: moved, clientUserMessageId: 'm-1' } },
  ]);
});

test('it leaves a message unanswered and sends it nowhere else when the old thread it may have taken it on does not read', async () => {
  const ctx = setupTest();
  const taken = Promise.withResolvers<undefined>();

  const server = startStubCodexAppServer(
    ctx.socket,
    { dropBeforeTurnStart: 1, refuseTurnsListOf: ['thread-1'] },
    (request) => {
      if (request.method === 'turn/start') {
        taken.resolve(undefined);
      }
    },
  );

  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
    retryMs: { first: 10, max: 50 },
  });

  onTestFinished(() => {
    bridge.stop();
  });

  const first = await bridge.open();

  bridge.startDelivery();

  const moved = await startCodexTerminalThread(ctx.socket);

  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await taken.promise;

  bridge.updateThread(moved);

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('unanswered');
  });

  expect(first).toBe('thread-1');

  expect(stub.notes).toStrictEqual([
    { kind: 'unanswered', messages: ['m-1'], reason: 'thread_switched' },
  ]);

  expect(server.requests.filter((request) => request.method === 'turn/start')).toMatchObject([
    { params: { threadId: first, clientUserMessageId: 'm-1' } },
  ]);
});

test('it keeps a message queued and sends it nowhere while the history of the old thread it may have taken it on fails to read', async () => {
  const ctx = setupTest();
  const taken = Promise.withResolvers<undefined>();

  const server = startStubCodexAppServer(
    ctx.socket,
    { dropBeforeTurnStart: 1, failTurnsListFrom: 2 },
    (request) => {
      if (request.method === 'turn/start') {
        taken.resolve(undefined);
      }
    },
  );

  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
    retryMs: { first: 10, max: 20 },
  });

  onTestFinished(() => {
    bridge.stop();
  });

  const first = await bridge.open();

  bridge.startDelivery();

  const moved = await startCodexTerminalThread(ctx.socket);

  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await taken.promise;

  bridge.updateThread(moved);

  await waitFor(() => {
    expect(
      server.requests.filter((request) => request.method === 'thread/turns/list'),
    ).toHaveLength(2);
  });

  expect(server.requests.filter((request) => request.method === 'thread/turns/list')).toMatchObject(
    [{ params: { threadId: first } }, { params: { threadId: first } }],
  );

  expect(stub.statuses.get('m-1')).toBe('queued');
  expect(stub.notes).toStrictEqual([]);

  expect(server.requests.filter((request) => request.method === 'turn/start')).toMatchObject([
    { params: { threadId: first, clientUserMessageId: 'm-1' } },
  ]);
});

test('it settles a later message with the turn it left running when the terminal comes back to it', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { holdTurns: true, reply: 'both done' });
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = createAppServerBridge({
    session: 's-1',
    cwd: '/work/repo',
    host: stub.host,
    openConnection: ctx.openConnection,
    resumeThread: null,
    retryMs: { first: 10, max: 50 },
  });

  onTestFinished(() => {
    bridge.stop();
  });

  const first = await bridge.open();

  bridge.startDelivery();
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('delivered');
  });

  const moved = await startCodexTerminalThread(ctx.socket);

  bridge.updateThread(moved);

  await waitFor(() => {
    expect(stub.attaches).toBe(2);
  });

  bridge.updateThread(first);

  await waitFor(() => {
    expect(stub.attaches).toBe(3);
  });

  stub.queueMessage({ id: 'm-2', from: 'planner', text: 'and the lint' });

  await waitFor(() => {
    expect(stub.statuses.get('m-2')).toBe('delivered');
  });

  server.completeHeldTurns();

  await waitFor(() => {
    expect(stub.statuses.get('m-2')).toBe('answered');
  });

  expect(stub.statuses.get('m-1')).toBe('unanswered');

  expect(stub.notes).toStrictEqual([
    { kind: 'unanswered', messages: ['m-1'], reason: 'thread_switched' },
    { kind: 'answered', messages: ['m-2'], answer: 'both done', turn: expect.any(String) },
  ]);
});
