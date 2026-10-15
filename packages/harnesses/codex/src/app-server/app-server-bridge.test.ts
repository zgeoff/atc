import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import {
  buildStubMessageBridgeHost,
  setupTempDir,
  startStubCodexAppServer,
  waitFor,
} from '@atc/test-utils';
import { AppServerBridge } from './app-server-bridge';
import { AppServerConnection } from './app-server-connection';

function setupTest() {
  const tmp = setupTempDir('atc-app-server-bridge-');
  const socket = join(tmp.dir, 'codex.sock');

  return {
    socket,
    openConnection: () => AppServerConnection.open(`ws+unix://${socket}`),
  };
}

test('it delivers a queued message with turn/start and answers it with the turn reply', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { reply: 'the build passes' });
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = new AppServerBridge({
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

  await waitFor(() => expect(stub.statuses.get('m-1')).toBe('answered'));

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

  const bridge = new AppServerBridge({
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

  expect(server.requests.map((r) => r.method)).toStrictEqual([
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

  const bridge = new AppServerBridge({
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

  const bridge = new AppServerBridge({
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

  await waitFor(() =>
    expect(server.requests.filter((r) => r.method === 'thread/turns/list').length).toBeGreaterThan(
      2,
    ),
  );

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

  const bridge = new AppServerBridge({
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

  await waitFor(() => expect(stub.statuses.get('m-1')).toBe('answered'));
  await waitFor(() => expect(stub.attaches).toBe(2));

  expect(server.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);

  expect(stub.notes).toStrictEqual([
    { kind: 'answered', messages: ['m-1'], answer: 'answered once', turn: 'turn-2' },
  ]);
});

test('it settles a message the server took before the daemon marked it, and sends it no more', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { reply: 'done earlier' });
  const first = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const earlier = new AppServerBridge({
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

  await waitFor(() => expect(first.statuses.get('m-1')).toBe('answered'));

  earlier.stop();

  const stub = buildStubMessageBridgeHost([{ id: 'm-1', status: 'queued' }]);

  const bridge = new AppServerBridge({
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

  await waitFor(() => expect(stub.statuses.get('m-1')).toBe('answered'));

  expect(server.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);

  expect(stub.notes).toStrictEqual([
    { kind: 'answered', messages: ['m-1'], answer: 'done earlier', turn: 'turn-2' },
  ]);
});

test('it leaves a delivered message that no stored turn holds unanswered as never started', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, {});
  const stub = buildStubMessageBridgeHost([{ id: 'm-lost', status: 'delivered' }]);

  onTestFinished(() => server.stop());

  const bridge = new AppServerBridge({
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

  await waitFor(() => expect(stub.statuses.get('m-lost')).toBe('unanswered'));

  expect(stub.notes).toStrictEqual([
    { kind: 'unanswered', messages: ['m-lost'], reason: 'not_started' },
  ]);
});

test('it records a note the model calls atc.note with', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { holdTurns: true });
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = new AppServerBridge({
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

  await waitFor(() => expect(stub.statuses.get('m-1')).toBe('delivered'));

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

  const bridge = new AppServerBridge({
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

  await waitFor(() => expect(stub.statuses.get('m-1')).toBe('delivered'));

  const result = await server.callTool('answer', { message: 'm-1', text: 'it passes' });

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

  const bridge = new AppServerBridge({
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

  await waitFor(() => expect(stub.statuses.get('m-1')).toBe('delivered'));

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

  const bridge = new AppServerBridge({
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

  await waitFor(() => expect(opened?.isOpen).toBe(false));

  expect(server.requests).toStrictEqual([]);
});

test('it leaves a message the App Server refuses unanswered and keeps the connection', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { rejectTurnStarts: true });
  const stub = buildStubMessageBridgeHost();

  onTestFinished(() => server.stop());

  const bridge = new AppServerBridge({
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

  await waitFor(() => expect(stub.statuses.get('m-2')).toBe('unanswered'));

  expect(stub.statuses.get('m-1')).toBe('unanswered');

  expect(stub.notes).toStrictEqual([
    { kind: 'unanswered', messages: ['m-1'], reason: 'error' },
    { kind: 'unanswered', messages: ['m-2'], reason: 'error' },
  ]);

  expect(server.requests.filter((r) => r.method === 'initialize')).toHaveLength(1);
});
