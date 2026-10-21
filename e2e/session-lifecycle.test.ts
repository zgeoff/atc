import { expect, test } from 'bun:test';
import { LOCAL_TARGET, parseConfig } from '@atc/config';
import { buildStubTargets, createStubAgentCLIs } from '@atc/daemon/testing';
import {
  buildMockHostServices,
  getRecord,
  getString,
  setupTempDir,
  waitFor,
  waitForEvent,
} from '@atc/test-utils';
import { buildAgentAdapters } from '../packages/app/src/agents/build-agent-adapters';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// A daemon in the test's process whose Claude runs as the in-process
// stand-in, reporting its hooks over the daemon's real reporter socket.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-session-lifecycle-');
  const agents = createStubAgentCLIs(temporaryDirectory.path);

  const daemon = await startTestDaemon({
    prefix: 'atc-session-lifecycle-',
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, { agents: { claude: { bin: agents.bins.claude } } }),
        buildMockHostServices(),
      ),
      targets: buildStubTargets([LOCAL_TARGET], { spawned: [], onStart: agents.start }),
    }),
  });

  return { daemon, agents, home: temporaryDirectory.path };
}

test('it spawns a session and broadcasts SessionAdded to every client', async () => {
  const ctx = await setupTest();
  const actor = await ctx.daemon.openClient();

  const actorEvents: unknown[] = [];

  actor.onEvent = (event) => {
    actorEvents.push(event);
  };

  const ok = await actor.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });
  const added = await waitForEvent(ctx.daemon.events, { ev: 'SessionAdded' });

  await waitFor(() => {
    expect(actorEvents).toContainEqual(added);
  });

  expect(ok).toStrictEqual({
    session: expect.objectContaining({ kind: 'pty', alive: true }),
  });

  expect(added).toMatchObject({
    session: { id: getRecord(ok, 'session')['id'], cwd: ctx.home, state: 'running' },
  });
});

test('it turns hook notifications into SessionState broadcasts', async () => {
  const ctx = await setupTest();

  await ctx.daemon.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const changed = await waitForEvent(ctx.daemon.events, {
    ev: 'SessionState',
    session: { state: 'needs_you' },
  });

  const listed = await ctx.daemon.client.sendRequest('session.list');

  expect(changed).toMatchObject({ session: { lastMsg: 'needs permission' } });

  expect(listed).toMatchObject({
    sessions: [{ state: 'needs_you', lastMsg: 'needs permission', agentSessionID: 'fake-1' }],
  });
});

test('it renames and pins a session through session.update', async () => {
  const ctx = await setupTest();

  const ok = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await ctx.daemon.client.sendRequest('session.update', {
    session: id,
    name: 'auth-bug',
    pinned: true,
  });

  const renamed = await waitForEvent(ctx.daemon.events, { ev: 'SessionRenamed', name: 'auth-bug' });
  const listed = await ctx.daemon.client.sendRequest('session.list');

  expect(renamed).toMatchObject({ sessionID: id, namedBy: 'user' });
  expect(listed).toMatchObject({ sessions: [{ name: 'auth-bug', pinned: true, namedBy: 'user' }] });
});

test('it unpins a pinned session through session.update', async () => {
  const ctx = await setupTest();

  const ok = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await ctx.daemon.client.sendRequest('session.update', { session: id, pinned: true });
  await ctx.daemon.client.sendRequest('session.update', { session: id, pinned: false });

  const listed = await ctx.daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({ sessions: [{ id, pinned: false }] });
});

test('it rejects session.update on an unknown session with no_such_session', async () => {
  const ctx = await setupTest();

  expect(
    ctx.daemon.client.sendRequest('session.update', { session: 'nope', name: 'x' }),
  ).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it kills a live session to exited', async () => {
  const ctx = await setupTest();

  const ok = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await ctx.daemon.client.sendRequest('session.kill', { session: id });

  const killed = await waitForEvent(ctx.daemon.events, {
    ev: 'SessionState',
    session: { lastMsg: 'killed' },
  });

  const listed = await ctx.daemon.client.sendRequest('session.list');

  expect(killed).toMatchObject({ session: { id, state: 'exited', alive: false } });
  expect(listed).toMatchObject({ sessions: [{ id, state: 'exited', alive: false }] });
});

test('it removes a killed session on a second kill', async () => {
  const ctx = await setupTest();

  const ok = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await ctx.daemon.client.sendRequest('session.kill', { session: id });

  await waitForEvent(ctx.daemon.events, { ev: 'SessionState', session: { lastMsg: 'killed' } });

  await ctx.daemon.client.sendRequest('session.kill', { session: id });

  const removed = await waitForEvent(ctx.daemon.events, { ev: 'SessionRemoved' });
  const listed = await ctx.daemon.client.sendRequest('session.list');

  expect(removed).toMatchObject({ sessionID: id });
  expect(listed).toStrictEqual({ sessions: [] });
});

test('it builds a resume command once the claude id is captured', async () => {
  const ctx = await setupTest();

  const ok = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(ctx.daemon.events, {
    ev: 'SessionState',
    session: { agentSessionID: 'fake-1' },
  });

  const answer = await ctx.daemon.client.sendRequest('session.resumeCommand', { session: id });

  expect(answer).toStrictEqual({
    command: `cd '${ctx.home}' && ${ctx.agents.bins.claude} --resume fake-1`,
  });
});

test('it broadcasts PermissionRequested when a session needs input', async () => {
  const ctx = await setupTest();

  const ok = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const requested = await waitForEvent(ctx.daemon.events, { ev: 'PermissionRequested' });

  expect(requested).toMatchObject({
    sessionID: getRecord(ok, 'session')['id'],
    message: 'needs permission',
    respondable: false,
    request: expect.toBeString(),
  });
});

test('it answers permission.respond on a keystroke-only request with unsupported', async () => {
  const ctx = await setupTest();

  await ctx.daemon.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const requested = await waitForEvent(ctx.daemon.events, { ev: 'PermissionRequested' });

  expect(
    ctx.daemon.client.sendRequest('permission.respond', {
      request: getString(requested, 'request'),
      decision: 'allow',
    }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it resolves a pending permission request as dismissed when the session dies', async () => {
  const ctx = await setupTest();

  const ok = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  const requested = await waitForEvent(ctx.daemon.events, { ev: 'PermissionRequested' });

  const request = getString(requested, 'request');

  await ctx.daemon.client.sendRequest('session.kill', { session: id });

  const resolved = await waitForEvent(ctx.daemon.events, { ev: 'PermissionResolved', request });

  expect(resolved).toMatchObject({ decision: 'dismissed' });
});

test('it keeps the last screen of a killed session readable', async () => {
  const ctx = await setupTest();

  const ok = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_CLAUDE_UP');
  });

  await ctx.daemon.client.sendRequest('session.kill', { session: id });

  await waitForEvent(ctx.daemon.events, { ev: 'SessionState', session: { lastMsg: 'killed' } });

  const screen = await ctx.daemon.client.sendRequest('session.screen', { session: id });

  expect(screen['text']).toInclude('FAKE_CLAUDE_UP');
});

test.each([
  ['session.input', { data: 'x' }],
  ['session.submit', { text: 'x' }],
  ['session.attach', { cols: 80, rows: 24 }],
])('it answers %s on a dead session with session_dead', async (method, params) => {
  const ctx = await setupTest();

  const ok = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await ctx.daemon.client.sendRequest('session.kill', { session: id });

  await waitForEvent(ctx.daemon.events, { ev: 'SessionState', session: { lastMsg: 'killed' } });

  expect(ctx.daemon.client.sendRequest(method, { session: id, ...params })).rejects.toMatchObject({
    code: 'session_dead',
  });
});

test("it reports a session's pending prompt through session.get while it needs you", async () => {
  const ctx = await setupTest();

  const start = Date.now();

  const ok = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    name: 'pending-check',
    prompt: 'fix the auth bug',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(ctx.daemon.events, { ev: 'SessionState', session: { state: 'needs_you' } });

  const record = await ctx.daemon.client.sendRequest('session.get', { session: id });

  expect(record).toMatchObject({
    prompt: 'fix the auth bug',
    pending: { message: 'needs permission' },
    result: null,
    session: { state: 'needs_you' },
  });

  expect(record['lastActivityAt']).toBeWithin(start, Date.now() + 1);
});

test("it reports a finished turn's last message through session.get", async () => {
  const ctx = await setupTest();

  ctx.agents.loadEvents('claude', [
    { hook_event_name: 'Stop', session_id: 'fake-1', last_assistant_message: 'All tests pass.' },
  ]);

  const ok = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(ctx.daemon.events, { ev: 'SessionState', session: { state: 'done' } });

  const record = await ctx.daemon.client.sendRequest('session.get', { session: id });

  expect(record).toMatchObject({ result: 'All tests pass.', pending: null });
});
