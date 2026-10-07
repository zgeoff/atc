import { expect, onTestFinished, test } from 'bun:test';
import { DaemonClient } from '../client/daemon-client';
import { LocalPTYProvider } from '../daemon/local-pty-provider';
import { DAEMON_FEATURES } from '../protocol/daemon-features';
import { getRecord } from '../shared/get-record';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildStubDestroyingProvider } from '../test-utils/build-stub-destroying-provider';
import { buildStubFleetCaller } from '../test-utils/build-stub-fleet-caller';
import { buildStubGatewayCaller } from '../test-utils/build-stub-gateway-caller';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { buildPrincipalCaller } from './build-principal-caller';
import { ReconnectingCaller } from './reconnecting-caller';
import { runTool } from './run-tool';

// A real daemon with one local target and `atc mcp`'s caller in front of it.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const daemon = await startTestDaemon({
    prefix: 'atc-run-tool-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        },
      ],
    }),
  });

  stack.use(daemon);

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  stack.defer(() => caller.stop());

  const owned = stack.move();

  return {
    caller,
    cwd: daemon.dir,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it hands out a token and changes nothing for a live session on a host-destroying target', async () => {
  const provider = buildStubDestroyingProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-run-tool-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const spawned = await caller.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const offered = await runTool(
    caller,
    'atc_session_forget',
    { session: id, stop: true },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(offered.structured).toStrictEqual({
    confirmToken: expect.toBeString(),
    expiresAt: expect.toBeNumber(),
  });

  expect(provider.destroyed).toBeEmpty();

  expect(caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, alive: true })],
  });
});

test('it destroys the host and drops the live session when the second call carries the token', async () => {
  const provider = buildStubDestroyingProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-run-tool-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const spawned = await caller.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const offered = await runTool(
    caller,
    'atc_session_forget',
    { session: id, stop: true },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  const forgotten = await runTool(
    caller,
    'atc_session_forget',
    { session: id, stop: true, confirmToken: offered.structured?.['confirmToken'] },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(forgotten.structured).toStrictEqual({ forgotten: true, destroyed: true });
  expect<readonly unknown[]>(provider.destroyed).toStrictEqual([id]);

  expect(
    runTool(
      caller,
      'atc_session_list',
      {},
      { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
    ),
  ).resolves.toStrictEqual({ text: expect.toBeString(), structured: { sessions: [] } });
});

test('it hands out a token for a dead session on a host-destroying target and changes nothing', async () => {
  const provider = buildStubDestroyingProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-run-tool-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const spawned = await caller.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await caller.sendRequest('session.kill', { session: id });

  const offered = await runTool(
    caller,
    'atc_session_forget',
    { session: id },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(offered.structured).toStrictEqual({
    confirmToken: expect.toBeString(),
    expiresAt: expect.toBeNumber(),
  });

  expect(provider.destroyed).toBeEmpty();
});

test('it forgets a dead session on a local target in one call', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.caller.sendRequest('session.kill', { session: id });

  const forgotten = await runTool(
    ctx.caller,
    'atc_session_forget',
    { session: id },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(forgotten.structured).toStrictEqual({ forgotten: true, destroyed: false });

  expect(
    runTool(
      ctx.caller,
      'atc_session_list',
      {},
      { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
    ),
  ).resolves.toStrictEqual({ text: expect.toBeString(), structured: { sessions: [] } });
});

test('it stops and forgets a live session on a local target in one call when stop is true', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const forgotten = await runTool(
    ctx.caller,
    'atc_session_forget',
    { session: id, stop: true },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(forgotten.structured).toStrictEqual({ forgotten: true, destroyed: false });

  expect(
    runTool(
      ctx.caller,
      'atc_session_list',
      {},
      { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
    ),
  ).resolves.toStrictEqual({ text: expect.toBeString(), structured: { sessions: [] } });
});

test('it refuses a live session without stop and leaves it running', async () => {
  const provider = buildStubDestroyingProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-run-tool-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const spawned = await caller.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const refused = runTool(
    caller,
    'atc_session_forget',
    { session: id },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(refused).rejects.toThrowWithMessage(Error, /^session_live: .*stop: true/);

  expect(caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, alive: true })],
  });
});

test('it refuses a pinned session and leaves it listed', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.caller.sendRequest('session.update', { session: id, pinned: true });

  const refused = runTool(
    ctx.caller,
    'atc_session_forget',
    { session: id, stop: true },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(refused).rejects.toThrowWithMessage(Error, /^session_pinned: .*atc_session_update/);

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, pinned: true, alive: true })],
  });
});

test('it refuses a sub-session of a pinned session and leaves both listed', async () => {
  await using ctx = await setupTest();

  const spawnedParent = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    cols: 80,
    rows: 24,
  });

  const parent = getRecord(spawnedParent, 'session')['id'];

  const spawnedChild = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.cwd,
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
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(refused).rejects.toThrowWithMessage(Error, /^session_pinned: /);

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id: parent }), expect.objectContaining({ id: child })],
  });
});

test('it refuses a session a pin reaches just before the forget does', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  // The pin lands on the daemon right before each request the tool sends,
  // the forget among them.
  const pinning = buildStubFleetCaller({
    answer: async (request) => {
      await ctx.caller.sendRequest('session.update', { session: id, pinned: true });

      return ctx.caller.sendRequest(request.m, request.p, request.required, request.principal);
    },
  });

  const refused = runTool(
    pinning,
    'atc_session_forget',
    { session: id, stop: true },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(refused).rejects.toThrowWithMessage(Error, /^session_pinned: .*atc_session_update/);

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, pinned: true, alive: true })],
  });
});

test('it checks the session itself and sends a plain forget to a daemon without the forget checks', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const older = buildStubFleetCaller({
    features: DAEMON_FEATURES.filter((feature) => feature !== 'session.forget.preconditions'),
    answer: (request) =>
      ctx.caller.sendRequest(request.m, request.p, request.required, request.principal),
  });

  const forgotten = await runTool(
    older,
    'atc_session_forget',
    { session: id, stop: true },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(forgotten.structured).toStrictEqual({ forgotten: true, destroyed: false });

  expect(older.requests).toStrictEqual([
    { m: 'session.get', p: { session: id } },
    { m: 'session.forget', p: { session: id }, required: ['session.forget'] },
  ]);
});

test('it falls back to its own check when a gateway routes the forget to a daemon without the forget checks', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.caller.sendRequest('session.update', { session: id, pinned: true });

  const refused = runTool(
    buildStubGatewayCaller(ctx.caller, { daemon: 'old', lacking: 'session.forget.preconditions' }),
    'atc_session_forget',
    { session: id, stop: true },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(refused).rejects.toThrowWithMessage(Error, /^session_pinned: .*atc_session_update/);
});

test('it refuses an unknown session as no_such_session before any token exists', async () => {
  const provider = buildStubDestroyingProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-run-tool-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const refused = runTool(
    caller,
    'atc_session_forget',
    { session: 'nope', stop: true },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(refused).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it refuses a principal a session on a target it cannot use as no_such_session and keeps the session', async () => {
  const provider = buildStubDestroyingProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-run-tool-forget-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
      principals: new Map([['outsider', ['elsewhere']]]),
    }),
  });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const spawned = await caller.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const refused = runTool(
    buildPrincipalCaller(caller, 'outsider'),
    'atc_session_forget',
    { session: id, stop: true },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(refused).rejects.toMatchObject({ code: 'no_such_session' });

  expect(caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id, alive: true })],
  });

  expect(provider.destroyed).toBeEmpty();
});
