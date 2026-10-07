import { expect, mock, onTestFinished, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAdapter } from '../agents/claude-adapter';
import { encodeCursor } from '../protocol/encode-cursor';
import type { EventMsg } from '../protocol/protocol';
import { getRecord } from '../shared/get-record';
import { isRecord } from '../shared/report';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockAgentEntry } from '../test-utils/build-mock-agent-entry';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { buildStubClock } from '../test-utils/build-stub-clock';
import { spawnNamedSession } from '../test-utils/spawn-named-session';
import { startStubTap } from '../test-utils/start-stub-tap';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { subscribeToSocketLines } from '../test-utils/subscribe-to-socket-lines';
import { waitFor } from '../test-utils/wait-for';

/**
 * A real daemon whose default agent, `claude`, reads hooks the way the
 * Claude adapter does and takes messages, beside a `grok` agent that takes
 * none. SessionMessage and SessionReport hooks append each event to
 * `hookLog`. `daemon.client` is the owner connection that acts; `tap` is a
 * second owner connection, and `tapEvents` holds every event it receives,
 * broadcasts included.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  // The Claude adapter's own hook reading marks a session started.
  const claude = new ClaudeAdapter(buildMockAgentEntry({ id: 'claude' }), {
    authProfiles: new Map(),
  });

  const started = await startTestDaemon({
    prefix: 'atc-messages-',
    options: (paths) => {
      const adapter = buildMockAgentAdapter({
        takesMessages: true,
        normalizeHook: (hook) => claude.normalizeHook(hook),
      });

      return {
        adapter,
        adapters: [adapter, buildMockAgentAdapter({ id: 'grok' })],
        hooks: {
          SessionMessage: [{ command: `cat >> '${join(paths.dir, 'hooks.log')}'` }],
          SessionReport: [{ command: `cat >> '${join(paths.dir, 'hooks.log')}'` }],
        },
      };
    },
  });

  const daemon = stack.use(started);

  const tap = await daemon.openClient();

  const tapEvents: EventMsg[] = [];

  tap.onEvent = (event) => {
    tapEvents.push(event);
  };

  const owned = stack.move();

  return {
    daemon,
    tap,
    tapEvents,
    hookLog: join(daemon.dir, 'hooks.log'),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it accepts a message for a session that has not reported SessionStart', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const ok = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
    from: 'alice',
  });

  expect(ok).toStrictEqual({ message: expect.stringMatching(/^m-/), status: 'accepted' });
});

test('it queues a message to a started session within the start-up grace window', async () => {
  const clock = buildStubClock(0);

  const claude = new ClaudeAdapter(buildMockAgentEntry({ id: 'claude' }), {
    authProfiles: new Map(),
  });

  await using ctx = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        normalizeHook: (hook) => claude.normalizeHook(hook),
      }),
      clock,
      tapGraceMs: 300,
    }),
  });

  const id = await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'one', ctx.dir);

  await ctx.sendHookLines({ atcId: id, event: 'SessionStart', payload: { session_id: 'agent-1' } });

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  clock.advance(299);

  const ok = await ctx.client.sendRequest('session.message', { session: id, text: 'hello' });

  expect(ok).toStrictEqual({ message: expect.stringMatching(/^m-/), status: 'accepted' });
});

test('it refuses a message once the grace window passes with no tap ever attached', async () => {
  const clock = buildStubClock(0);

  const claude = new ClaudeAdapter(buildMockAgentEntry({ id: 'claude' }), {
    authProfiles: new Map(),
  });

  await using ctx = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        normalizeHook: (hook) => claude.normalizeHook(hook),
      }),
      clock,
      tapGraceMs: 300,
    }),
  });

  const id = await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'one', ctx.dir);

  await ctx.sendHookLines({ atcId: id, event: 'SessionStart', payload: { session_id: 'agent-1' } });

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  clock.advance(300);

  expect(
    ctx.client.sendRequest('session.message', { session: id, text: 'late' }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it accepts a message to a started session once a tap is connected', async () => {
  const claude = new ClaudeAdapter(buildMockAgentEntry({ id: 'claude' }), {
    authProfiles: new Map(),
  });

  await using ctx = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        normalizeHook: (hook) => claude.normalizeHook(hook),
      }),
      tapGraceMs: 0,
    }),
  });

  const id = await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'one', ctx.dir);

  await ctx.sendHookLines({ atcId: id, event: 'SessionStart', payload: { session_id: 'agent-1' } });

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  const tap = await ctx.openClient();

  await tap.sendRequest('session.tap', { session: id });

  const ok = await ctx.client.sendRequest('session.message', { session: id, text: 'hello' });

  expect(ok).toStrictEqual({ message: expect.stringMatching(/^m-/), status: 'accepted' });
});

test('it refuses a message to a session whose agent cannot take messages', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    name: 'grok-one',
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  expect(
    ctx.daemon.client.sendRequest('session.message', {
      session: getRecord(spawned, 'session')['id'],
      text: 'hello',
    }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it answers a message for an unknown session with no_such_session', async () => {
  await using ctx = await setupTest();

  expect(
    ctx.daemon.client.sendRequest('session.message', { session: 'nope', text: 'hello' }),
  ).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it answers a message for a killed session with session_dead', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.daemon.client.sendRequest('session.kill', { session: id });

  expect(
    ctx.daemon.client.sendRequest('session.message', { session: id, text: 'hello' }),
  ).rejects.toMatchObject({ code: 'session_dead' });
});

test('it rejects a message without text as bad_args', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  expect(ctx.daemon.client.sendRequest('session.message', { session: id })).rejects.toMatchObject({
    code: 'bad_args',
  });
});

test('it lists a session the fleet restore has not reached yet as waiting to restore', async () => {
  await using ctx = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      onTestFinished(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-agent-a'), cwd: paths.dir }),
        buildMockFleetEntry({ sessionID: toSessionID('s-agent-b'), name: 'b', cwd: paths.dir }),
      ]);

      return { adapter: buildMockAgentAdapter({ takesMessages: true }) };
    },
  });

  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await ctx.client.sendRequest('session.list');

  expect(listed['sessions']).toPartiallyContain({
    id: 's-agent-b',
    name: 'b',
    lastMsg: 'waiting to restore',
  });
});

test('it queues a message for a session waiting to restore', async () => {
  await using ctx = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      onTestFinished(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-agent-a'), cwd: paths.dir }),
        buildMockFleetEntry({ sessionID: toSessionID('s-agent-b'), cwd: paths.dir }),
      ]);

      return { adapter: buildMockAgentAdapter({ takesMessages: true }) };
    },
  });

  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const ok = await ctx.client.sendRequest('session.message', {
    session: 's-agent-b',
    text: 'hello',
  });

  expect(ok).toStrictEqual({ message: expect.stringMatching(/^m-/), status: 'accepted' });
});

test('it drains pending messages to a tap in the order they were sent', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const first = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'one',
    from: 'alice',
  });

  const second = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'two',
    from: 'alice',
  });

  const third = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'three',
    from: 'alice',
  });

  const tap = await startStubTap(ctx.tap, id);

  await waitFor(() => {
    expect(tap.messages).toStrictEqual([
      {
        v: 4,
        ev: 'InboxMessage',
        s: id,
        message: first['message'],
        from: 'alice',
        text: 'one',
        sentAt: expect.any(Number),
      },
      {
        v: 4,
        ev: 'InboxMessage',
        s: id,
        message: second['message'],
        from: 'alice',
        text: 'two',
        sentAt: expect.any(Number),
      },
      {
        v: 4,
        ev: 'InboxMessage',
        s: id,
        message: third['message'],
        from: 'alice',
        text: 'three',
        sentAt: expect.any(Number),
      },
    ]);
  });
});

test('it streams a message accepted while the tap is connected', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.tap.sendRequest('session.tap', { session: id });

  const ok = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'live',
    from: 'bob',
  });

  await waitFor(() => {
    expect(ctx.tapEvents.filter((event) => event.ev === 'InboxMessage')).toStrictEqual([
      {
        v: 4,
        ev: 'InboxMessage',
        s: id,
        message: ok['message'],
        from: 'bob',
        text: 'live',
        sentAt: expect.any(Number),
      },
    ]);
  });
});

test('it drains two hundred pending messages to a tap with zero loss', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const sent: unknown[] = [];

  for (let i = 0; i < 200; i++) {
    const ok = await ctx.daemon.client.sendRequest('session.message', {
      session: id,
      text: `message ${i}`,
    });

    sent.push(ok['message']);
  }

  const tap = await startStubTap(ctx.tap, id);

  await waitFor(() => {
    expect(tap.messages.map((event) => event['message'])).toStrictEqual(sent);
  });
});

test('it drains a backlog larger than the outbound queue without dropping the tap', async () => {
  await using ctx = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }), queueBytes: 4096 }),
  });

  const id = await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'one', ctx.dir);

  const sent: unknown[] = [];

  for (let i = 0; i < 12; i++) {
    const ok = await ctx.client.sendRequest('session.message', {
      session: id,
      text: `${i}`.padEnd(1500, 'x'),
    });

    sent.push(ok['message']);
  }

  const tapClient = await ctx.openClient();
  const tap = await startStubTap(tapClient, id);

  await waitFor(() => {
    expect(tap.messages.map((event) => event['message'])).toStrictEqual(sent);
  });
});

test('it refuses a tap on a session whose agent cannot take messages', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    name: 'grok-one',
    cwd: ctx.daemon.dir,
    agent: 'grok',
  });

  expect(
    ctx.tap.sendRequest('session.tap', { session: getRecord(spawned, 'session')['id'] }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it refuses a tap on an unknown session', async () => {
  await using ctx = await setupTest();

  expect(ctx.tap.sendRequest('session.tap', { session: 'nope' })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test('it moves an acked message to delivered', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
    from: 'alice',
  });

  await ctx.tap.sendRequest('session.tap', { session: id });

  const acked = await ctx.tap.sendRequest('message.ack', {
    session: id,
    message: sent['message'],
  });

  expect(acked).toStrictEqual({ message: sent['message'], status: 'delivered' });
});

test('it broadcasts SessionMessage for an acked message', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
    from: 'alice',
  });

  await ctx.tap.sendRequest('session.tap', { session: id });
  await ctx.tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  await waitFor(() => {
    expect(ctx.daemon.events).toContainEqual({
      v: 4,
      ev: 'SessionMessage',
      s: id,
      message: sent['message'],
      status: 'delivered',
      from: 'alice',
      textPreview: 'hello',
      sentAt: expect.any(Number),
      deliveredAt: expect.any(Number),
    });
  });
});

test('it refuses an ack from a connection that is not the session tap', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await ctx.tap.sendRequest('session.tap', { session: id });

  expect(
    ctx.daemon.client.sendRequest('message.ack', {
      session: id,
      message: sent['message'],
    }),
  ).rejects.toMatchObject({ code: 'bad_args' });
});

test('it answers a repeat ack with the current status', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await ctx.tap.sendRequest('session.tap', { session: id });
  await ctx.tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  const repeat = await ctx.tap.sendRequest('message.ack', {
    session: id,
    message: sent['message'],
  });

  expect(repeat).toStrictEqual({ message: sent['message'], status: 'delivered' });
});

test('it broadcasts delivered once for a repeat ack', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await ctx.tap.sendRequest('session.tap', { session: id });
  await ctx.tap.sendRequest('message.ack', { session: id, message: sent['message'] });
  await ctx.tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  // The daemon answers one connection's requests in order, so the ping's
  // answer follows every broadcast the acks made.
  await ctx.daemon.client.sendRequest('daemon.ping');

  expect<readonly unknown[]>(
    ctx.daemon.events.filter((e) => e.ev === 'SessionMessage' && e['status'] === 'delivered'),
  ).toStrictEqual([expect.objectContaining({ message: sent['message'] })]);
});

test('it rejects an ack of an unknown message as bad_args', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.tap.sendRequest('session.tap', { session: id });

  expect(
    ctx.tap.sendRequest('message.ack', { session: id, message: 'm-unknown' }),
  ).rejects.toMatchObject({ code: 'bad_args' });
});

test('it moves a message to answered from a Report line on the reporter socket', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
    from: 'alice',
  });

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: { kind: 'answered', message: sent['message'], answer: 'done' },
  });

  await waitFor(() => {
    expect(ctx.daemon.events).toContainEqual({
      v: 4,
      ev: 'SessionMessage',
      s: id,
      message: sent['message'],
      status: 'answered',
      from: 'alice',
      textPreview: 'hello',
      sentAt: expect.any(Number),
      answeredAt: expect.any(Number),
      answerPreview: 'done',
    });
  });
});

test('it ignores an answered report from another session', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const other = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'two',
    ctx.daemon.dir,
  );

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await ctx.daemon.sendHookLines({
    atcId: other,
    event: 'Report',
    payload: { kind: 'answered', message: sent['message'], answer: 'bogus' },
  });

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: { kind: 'answered', message: sent['message'], answer: 'valid' },
  });

  await waitFor(() => {
    expect(ctx.daemon.events).toPartiallyContain({ ev: 'SessionMessage', status: 'answered' });
  });

  expect<readonly unknown[]>(
    ctx.daemon.events.filter((e) => e.ev === 'SessionMessage' && e['status'] === 'answered'),
  ).toStrictEqual([expect.objectContaining({ s: id, answerPreview: 'valid' })]);
});

test('it keeps queueing messages after the tap connection drops', async () => {
  const claude = new ClaudeAdapter(buildMockAgentEntry({ id: 'claude' }), {
    authProfiles: new Map(),
  });

  await using ctx = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        normalizeHook: (hook) => claude.normalizeHook(hook),
      }),
      tapGraceMs: 0,
    }),
  });

  const id = await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'one', ctx.dir);

  await ctx.sendHookLines({ atcId: id, event: 'SessionStart', payload: { session_id: 'agent-1' } });

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  const tap = await ctx.openClient();

  await tap.sendRequest('session.tap', { session: id });
  await ctx.client.sendRequest('session.message', { session: id, text: 'while tapped' });

  tap.stop();

  // The daemon has let the tap go once it no longer counts the connection.
  await waitFor(() => {
    expect(ctx.daemon.countClients()).toBe(1);
  });

  const queued = await ctx.client.sendRequest('session.message', { session: id, text: 'after' });

  expect(queued).toStrictEqual({ message: expect.stringMatching(/^m-/), status: 'accepted' });
});

test('it refuses a message to a session whose process died even after a tap attached', async () => {
  await using ctx = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }), tapGraceMs: 0 }),
  });

  const id = await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'one', ctx.dir);
  const tap = await ctx.openClient();

  await tap.sendRequest('session.tap', { session: id });
  await ctx.client.sendRequest('session.kill', { session: id });

  expect(
    ctx.client.sendRequest('session.message', { session: id, text: 'hello' }),
  ).rejects.toMatchObject({ code: 'session_dead' });
});

test('it broadcasts SessionMessage on the events socket', async () => {
  await using ctx = await setupTest();
  await using subscriber = await subscribeToSocketLines(ctx.daemon.eventsSocketPath);

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  await waitFor(() => {
    expect(subscriber.lines.join('\n')).toInclude('"ev":"SessionMessage"');
  });
});

test('it runs SessionMessage hooks with the event on stdin', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  await waitFor(() => {
    expect(readFileSync(ctx.hookLog, 'utf8')).toInclude('"status":"accepted"');
  });
});

test('it broadcasts a note from the reporter socket as SessionReport', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: { kind: 'note', label: 'blocked', text: 'need review' },
  });

  await waitFor(() => {
    expect(ctx.daemon.events).toContainEqual({
      v: 4,
      ev: 'SessionReport',
      s: id,
      kind: 'blocked',
      text: 'need review',
      reportedAt: expect.any(Number),
    });
  });
});

test('it ignores a note from an unknown session', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.daemon.sendHookLines({
    atcId: 'nope',
    event: 'Report',
    payload: { kind: 'note', label: 'blocked', text: 'bogus' },
  });

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: { kind: 'note', label: 'blocked', text: 'valid' },
  });

  await waitFor(() => {
    expect(ctx.daemon.events).toPartiallyContain({ ev: 'SessionReport' });
  });

  expect<readonly unknown[]>(
    ctx.daemon.events.filter((e) => e.ev === 'SessionReport'),
  ).toStrictEqual([expect.objectContaining({ s: id, text: 'valid' })]);
});

test('it broadcasts SessionReport on the events socket', async () => {
  await using ctx = await setupTest();
  await using subscriber = await subscribeToSocketLines(ctx.daemon.eventsSocketPath);

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: { kind: 'note', label: 'progress', text: 'halfway' },
  });

  await waitFor(() => {
    expect(subscriber.lines.join('\n')).toInclude('"ev":"SessionReport"');
  });
});

test('it runs SessionReport hooks with the event on stdin', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: { kind: 'note', label: 'decision', text: 'pick one' },
  });

  await waitFor(() => {
    expect(readFileSync(ctx.hookLog, 'utf8')).toInclude('"ev":"SessionReport"');
  });
});

test('it keeps InboxMessage off every connection but the tap', async () => {
  await using ctx = await setupTest();
  await using subscriber = await subscribeToSocketLines(ctx.daemon.eventsSocketPath);

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.tap.sendRequest('session.tap', { session: id });
  await ctx.daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  // The tap's copy shows the daemon has sent the message out.
  await waitFor(() => {
    expect(ctx.tapEvents).toPartiallyContain({ ev: 'InboxMessage' });
  });

  await ctx.daemon.client.sendRequest('daemon.ping');

  expect<Record<string, unknown>>({
    client: ctx.daemon.events.map((e) => e.ev),
    socket: subscriber.lines.join('\n'),
  }).toStrictEqual({
    client: expect.not.arrayContaining(['InboxMessage']),
    socket: expect.not.stringContaining('InboxMessage'),
  });
});

test('it delivers pending messages to a new tap before a message accepted at the same time', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const pending: Readonly<Record<string, unknown>>[] = [];

  for (let i = 0; i < 5; i++) {
    const ok = await ctx.daemon.client.sendRequest('session.message', {
      session: id,
      text: `${i}`,
    });

    pending.push(ok);
  }

  const [tap, live] = await Promise.all([
    startStubTap(ctx.tap, id),
    ctx.daemon.client.sendRequest('session.message', { session: id, text: 'live' }),
  ]);

  await waitFor(() => {
    expect(tap.messages.map((e) => e['message'])).toStrictEqual(
      [...pending, live].map((ok) => ok['message']),
    );
  });
});

test('it orders concurrently accepted messages by their sent time', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const tap = await startStubTap(ctx.tap, id);

  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      ctx.daemon.client.sendRequest('session.message', { session: id, text: `${i}` }),
    ),
  );

  await waitFor(() => {
    expect(tap.messages).toHaveLength(20);
  });

  const sentAt = tap.messages.map((e) => Number(e['sentAt']));

  expect(sentAt).toStrictEqual(sentAt.toSorted((a, b) => a - b));

  expect(tap.messages.map((e) => e['text'])).toStrictEqual(
    Array.from({ length: 20 }, (_, i) => `${i}`),
  );
});

test('it reads an accepted message back through message.get', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
    from: 'alice',
  });

  const accepted = await ctx.daemon.client.sendRequest('message.get', {
    message: sent['message'],
  });

  expect(accepted).toStrictEqual({
    message: sent['message'],
    session: id,
    from: 'alice',
    text: 'hello',
    status: 'accepted',
    sentAt: expect.any(Number),
    turn: null,
    answeredWith: [],
  });
});

test('it reads a delivered message back through message.get', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
    from: 'alice',
  });

  await ctx.tap.sendRequest('session.tap', { session: id });
  await ctx.tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  const delivered = await ctx.daemon.client.sendRequest('message.get', {
    message: sent['message'],
  });

  expect(delivered).toStrictEqual({
    message: sent['message'],
    session: id,
    from: 'alice',
    text: 'hello',
    status: 'delivered',
    sentAt: expect.any(Number),
    deliveredAt: expect.any(Number),
    turn: null,
    answeredWith: [],
  });
});

test('it reads an answered message back through message.get', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
    from: 'alice',
  });

  await ctx.tap.sendRequest('session.tap', { session: id });
  await ctx.tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: { kind: 'answered', message: sent['message'], answer: 'done' },
  });

  await waitFor(async () => {
    const answered = await ctx.daemon.client.sendRequest('message.get', {
      message: sent['message'],
    });

    expect(answered).toStrictEqual({
      message: sent['message'],
      session: id,
      from: 'alice',
      text: 'hello',
      status: 'answered',
      answer: 'done',
      sentAt: expect.any(Number),
      deliveredAt: expect.any(Number),
      answeredAt: expect.any(Number),
      turn: null,
      answeredWith: [],
    });
  });
});

test('it returns the full text and answer through message.get while the event carries previews', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const text = 't'.repeat(3000);
  const answer = 'a'.repeat(3000);

  const sent = await ctx.daemon.client.sendRequest('session.message', { session: id, text });

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: { kind: 'answered', message: sent['message'], answer },
  });

  await waitFor(() => {
    expect(ctx.daemon.events).toPartiallyContain({ ev: 'SessionMessage', status: 'answered' });
  });

  const got = await ctx.daemon.client.sendRequest('message.get', { message: sent['message'] });

  const broadcast = ctx.daemon.events.filter((e) => e.ev === 'SessionMessage');

  expect(got).toMatchObject({ text, answer });
  expect(broadcast).toSatisfyAll((e) => !('text' in e) && !('answer' in e));
  expect(broadcast.map((e) => e['textPreview'])).toSatisfyAll((p) => p === `${'t'.repeat(599)}…`);
});

test('it caps a stored answer at the byte limit without splitting a character', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  // Each 'é' is two bytes, and the cut that leaves room for the ellipsis
  // falls inside one.
  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: { kind: 'answered', message: sent['message'], answer: 'é'.repeat(40_000) },
  });

  const got = await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('message.get', { message: sent['message'] });

    expect(read['status']).toBe('answered');

    return read;
  });

  expect(got['answer']).toBe(`${'é'.repeat(32_766)}…`);
  expect(new TextEncoder().encode(String(got['answer']))).toHaveLength(65_535);
});

test('it gives two messages one turn answered the same turn and lists each beside the other', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const first = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'one',
  });

  const second = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'two',
  });

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: {
      kind: 'answered',
      messages: [first['message'], second['message']],
      answer: 'both',
      turn: 't-1',
    },
  });

  await waitFor(async () => {
    const got = await ctx.daemon.client.sendRequest('message.get', { message: second['message'] });

    expect(got['status']).toBe('answered');
  });

  const firstGot = await ctx.daemon.client.sendRequest('message.get', {
    message: first['message'],
  });

  const secondGot = await ctx.daemon.client.sendRequest('message.get', {
    message: second['message'],
  });

  expect(firstGot).toMatchObject({
    answer: 'both',
    turn: 't-1',
    answeredWith: [second['message']],
  });

  expect(secondGot).toMatchObject({
    answer: 'both',
    turn: 't-1',
    answeredWith: [first['message']],
  });
});

test("it wakes a held read of one turn's message with the whole group already answered", async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const first = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'one',
  });

  const second = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'two',
  });

  const third = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'three',
  });

  const pending = ctx.daemon.client.sendRequest('message.get', {
    message: first['message'],
    waitMs: 10_000,
  });

  // The daemon answers one connection's requests in the order they started,
  // so the ping's answer means the held read already took its first look.
  await ctx.daemon.client.sendRequest('daemon.ping');

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: {
      kind: 'answered',
      messages: [first['message'], second['message'], third['message']],
      answer: 'all',
      turn: 't-1',
    },
  });

  const woken = await pending;

  expect(woken).toMatchObject({
    status: 'answered',
    turn: 't-1',
    answeredWith: [second['message'], third['message']],
  });
});

test('it lists no other messages for a message its own turn answered', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const first = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'one',
  });

  const second = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'two',
  });

  await ctx.daemon.sendHookLines(
    {
      atcId: id,
      event: 'Report',
      payload: { kind: 'answered', message: first['message'], answer: 'first', turn: 't-1' },
    },
    {
      atcId: id,
      event: 'Report',
      payload: { kind: 'answered', message: second['message'], answer: 'second', turn: 't-2' },
    },
  );

  await waitFor(async () => {
    const got = await ctx.daemon.client.sendRequest('message.get', { message: second['message'] });

    expect(got['status']).toBe('answered');
  });

  const firstGot = await ctx.daemon.client.sendRequest('message.get', {
    message: first['message'],
  });

  const secondGot = await ctx.daemon.client.sendRequest('message.get', {
    message: second['message'],
  });

  expect(firstGot).toMatchObject({ answer: 'first', turn: 't-1', answeredWith: [] });
  expect(secondGot).toMatchObject({ answer: 'second', turn: 't-2', answeredWith: [] });
});

test('it stores no turn for an answer reported without one', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const first = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'one',
  });

  const second = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'two',
  });

  await ctx.daemon.sendHookLines(
    {
      atcId: id,
      event: 'Report',
      payload: { kind: 'answered', message: first['message'], answer: 'both' },
    },
    {
      atcId: id,
      event: 'Report',
      payload: { kind: 'answered', message: second['message'], answer: 'both' },
    },
  );

  await waitFor(async () => {
    const got = await ctx.daemon.client.sendRequest('message.get', { message: second['message'] });

    expect(got['status']).toBe('answered');
  });

  const firstGot = await ctx.daemon.client.sendRequest('message.get', {
    message: first['message'],
  });

  const secondGot = await ctx.daemon.client.sendRequest('message.get', {
    message: second['message'],
  });

  expect(firstGot).toMatchObject({ answer: 'both', turn: null, answeredWith: [] });
  expect(secondGot).toMatchObject({ answer: 'both', turn: null, answeredWith: [] });
});

test('it holds message.get open until the message status changes', async () => {
  const clock = buildStubClock(0);

  await using ctx = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }), clock }),
  });

  const id = await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'one', ctx.dir);
  const sent = await ctx.client.sendRequest('session.message', { session: id, text: 'hello' });

  const pending = ctx.client.sendRequest('message.get', {
    message: sent['message'],
    waitMs: 10_000,
  });

  // The held read waits on a timer for the rest of its window.
  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([10_000]);
  });

  const tap = await ctx.openClient();

  await tap.sendRequest('session.tap', { session: id });
  await tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  const got = await pending;

  expect(got).toMatchObject({ message: sent['message'], status: 'delivered' });
});

test('it answers a held message.get with the unchanged status once the wait ends', async () => {
  const clock = buildStubClock(0);

  await using ctx = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }), clock }),
  });

  const id = await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'one', ctx.dir);
  const sent = await ctx.client.sendRequest('session.message', { session: id, text: 'hello' });

  const pending = ctx.client.sendRequest('message.get', { message: sent['message'], waitMs: 300 });

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([300]);
  });

  clock.advance(300);

  const got = await pending;

  expect(got).toMatchObject({ message: sent['message'], status: 'accepted' });
});

test('it answers message.get for an answered message at once whatever the wait', async () => {
  const clock = buildStubClock(0);

  await using ctx = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }), clock }),
  });

  const id = await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'one', ctx.dir);
  const sent = await ctx.client.sendRequest('session.message', { session: id, text: 'hello' });

  await ctx.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: { kind: 'answered', message: sent['message'], answer: 'done' },
  });

  await waitFor(async () => {
    const got = await ctx.client.sendRequest('message.get', { message: sent['message'] });

    expect(got['status']).toBe('answered');
  });

  // The clock never moves, so only a read that waits on no timer answers.
  const got = await ctx.client.sendRequest('message.get', {
    message: sent['message'],
    waitMs: 10_000,
  });

  expect(got).toMatchObject({ status: 'answered', answer: 'done' });
});

test('it rejects message.get for an unknown message as bad_args', async () => {
  await using ctx = await setupTest();

  expect(
    ctx.daemon.client.sendRequest('message.get', { message: 'm-unknown' }),
  ).rejects.toMatchObject({
    code: 'bad_args',
  });
});

test('it rejects message.get without a message as bad_args', async () => {
  await using ctx = await setupTest();

  expect(ctx.daemon.client.sendRequest('message.get', {})).rejects.toMatchObject({
    code: 'bad_args',
  });
});

test('it ends the earlier tap subscription when a second tap attaches', async () => {
  await using ctx = await setupTest();

  const replacement = await ctx.daemon.openClient();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.tap.sendRequest('session.tap', { session: id });
  await replacement.sendRequest('session.tap', { session: id });

  await waitFor(() => {
    expect(ctx.tapEvents.filter((e) => e.ev === 'InboxClosed')).toStrictEqual([
      { v: 4, ev: 'InboxClosed', s: id, reason: 'replaced' },
    ]);
  });
});

test('it keeps the tap subscription when the same connection taps again', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.tap.sendRequest('session.tap', { session: id });
  await ctx.tap.sendRequest('session.tap', { session: id });

  // Each connection's ping answers after every event the taps sent it.
  await ctx.daemon.client.sendRequest('daemon.ping');
  await ctx.tap.sendRequest('daemon.ping');

  expect(ctx.tapEvents.filter((e) => e.ev === 'InboxClosed')).toStrictEqual([]);
});

test('it ends the tap subscription when its session is removed', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.tap.sendRequest('session.tap', { session: id });

  // The first kill leaves an exited entry; the second removes it.
  await ctx.daemon.client.sendRequest('session.kill', { session: id });
  await ctx.daemon.client.sendRequest('session.kill', { session: id });

  await waitFor(() => {
    expect(ctx.tapEvents.filter((e) => e.ev === 'InboxClosed')).toStrictEqual([
      { v: 4, ev: 'InboxClosed', s: id, reason: 'removed' },
    ]);
  });
});

test('it records each message status change in events.read in order', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
    from: 'alice',
  });

  await ctx.tap.sendRequest('session.tap', { session: id });
  await ctx.tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: { kind: 'answered', message: sent['message'], answer: 'done' },
  });

  const read = await waitFor(async () => {
    const answer = await ctx.daemon.client.sendRequest('events.read', {});

    expect(answer['events']).toHaveLength(3);

    return answer;
  });

  expect(read).toStrictEqual({
    events: [
      {
        cursor: expect.toBeString(),
        at: expect.toBeNumber(),
        session: id,
        name: 'one',
        kind: 'message-accepted',
        detail: 'hello',
        message: sent['message'],
      },
      {
        cursor: expect.toBeString(),
        at: expect.toBeNumber(),
        session: id,
        name: 'one',
        kind: 'message-delivered',
        detail: 'hello',
        message: sent['message'],
      },
      {
        cursor: expect.toBeString(),
        at: expect.toBeNumber(),
        session: id,
        name: 'one',
        kind: 'message-answered',
        detail: 'done',
        message: sent['message'],
      },
    ],
    cursor: expect.toBeString(),
    more: false,
  });
});

test('it records a repeated ack in the trail once', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await ctx.tap.sendRequest('session.tap', { session: id });
  await ctx.tap.sendRequest('message.ack', { session: id, message: sent['message'] });
  await ctx.tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  const read = await ctx.daemon.client.sendRequest('events.read', {});

  expect(read['events']).toStrictEqual([
    expect.objectContaining({ kind: 'message-accepted' }),
    expect.objectContaining({ kind: 'message-delivered' }),
  ]);
});

test('it wakes a waiting events.read when a message is accepted', async () => {
  const clock = buildStubClock(0);

  await using ctx = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }), clock }),
  });

  const id = await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'one', ctx.dir);
  const first = await ctx.client.sendRequest('events.read', {});

  const pending = ctx.client.sendRequest('events.read', {
    cursor: first['cursor'],
    waitMs: 10_000,
  });

  // The clock never moves, so only the new event ends the wait.
  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([10_000]);
  });

  const sent = await ctx.client.sendRequest('session.message', { session: id, text: 'hello' });
  const woken = await pending;

  expect(woken['events']).toStrictEqual([
    {
      cursor: expect.toBeString(),
      at: expect.toBeNumber(),
      session: id,
      name: 'one',
      kind: 'message-accepted',
      detail: 'hello',
      message: sent['message'],
    },
  ]);
});

test("it limits events.read to one session's events", async () => {
  await using ctx = await setupTest();

  const one = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const two = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'two',
    ctx.daemon.dir,
  );

  await ctx.daemon.client.sendRequest('session.message', { session: one, text: 'to one' });
  await ctx.daemon.client.sendRequest('session.message', { session: two, text: 'to two' });

  const read = await ctx.daemon.client.sendRequest('events.read', { session: two });

  expect(read).toStrictEqual({
    events: [
      {
        cursor: expect.toBeString(),
        at: expect.toBeNumber(),
        session: two,
        name: 'two',
        kind: 'message-accepted',
        detail: 'to two',
        message: expect.toBeString(),
      },
    ],
    cursor: expect.toBeString(),
    more: false,
  });
});

test("it wakes a held events.read only for the filtered session's event", async () => {
  await using ctx = await setupTest();

  const one = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const two = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'two',
    ctx.daemon.dir,
  );

  const first = await ctx.daemon.client.sendRequest('events.read', {});

  const pending = ctx.daemon.client.sendRequest('events.read', {
    cursor: first['cursor'],
    session: two,
    waitMs: 10_000,
  });

  await ctx.daemon.client.sendRequest('session.message', { session: one, text: 'to one' });
  await ctx.daemon.client.sendRequest('session.message', { session: two, text: 'to two' });

  const woken = await pending;

  expect(woken['events']).toMatchObject([{ session: two, detail: 'to two' }]);
});

test('it marks an events.read page that stopped before the end of the trail', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const start = await ctx.daemon.client.sendRequest('events.read', {});

  await ctx.daemon.client.sendRequest('session.message', { session: id, text: 'a' });
  await ctx.daemon.client.sendRequest('session.message', { session: id, text: 'b' });
  await ctx.daemon.client.sendRequest('session.message', { session: id, text: 'c' });

  const page = await ctx.daemon.client.sendRequest('events.read', {
    cursor: start['cursor'],
    limit: 2,
  });

  expect(page).toMatchObject({ events: [{ detail: 'a' }, { detail: 'b' }], more: true });
});

test('it marks the events.read page that reaches the end of the trail as the last', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  const start = await ctx.daemon.client.sendRequest('events.read', {});

  await ctx.daemon.client.sendRequest('session.message', { session: id, text: 'a' });
  await ctx.daemon.client.sendRequest('session.message', { session: id, text: 'b' });
  await ctx.daemon.client.sendRequest('session.message', { session: id, text: 'c' });

  const page = await ctx.daemon.client.sendRequest('events.read', {
    cursor: start['cursor'],
    limit: 2,
  });

  const rest = await ctx.daemon.client.sendRequest('events.read', {
    cursor: page['cursor'],
    limit: 2,
  });

  expect(rest).toMatchObject({ events: [{ detail: 'c' }], more: false });
});

test('it records a note in events.read with its label', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: { kind: 'note', label: 'blocked', text: 'need review' },
  });

  const read = await waitFor(async () => {
    const answer = await ctx.daemon.client.sendRequest('events.read', {});

    expect(answer['events']).toHaveLength(1);

    return answer;
  });

  expect(read).toStrictEqual({
    events: [
      {
        cursor: expect.toBeString(),
        at: expect.toBeNumber(),
        session: id,
        name: 'one',
        kind: 'report',
        detail: 'need review',
        label: 'blocked',
      },
    ],
    cursor: expect.toBeString(),
    more: false,
  });
});

test("it returns a report's whole text by the cursor of its event", async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: { kind: 'note', label: 'decision', text: 'y'.repeat(700) },
  });

  const event = await waitFor(async () => {
    const answer = await ctx.daemon.client.sendRequest('events.read', {});

    if (!Array.isArray(answer['events']) || !isRecord(answer['events'][0])) {
      throw new TypeError('no event yet');
    }

    return answer['events'][0];
  });

  const report = await ctx.daemon.client.sendRequest('report.get', { report: event['cursor'] });

  expect({ preview: event['detail'], report }).toStrictEqual({
    preview: `${'y'.repeat(599)}…`,
    report: {
      report: event['cursor'],
      at: event['at'],
      session: id,
      name: 'one',
      label: 'decision',
      text: 'y'.repeat(700),
      complete: true,
    },
  });
});

test("it returns a report's text cut at 64 KiB", async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: { kind: 'note', label: 'evidence', text: 'z'.repeat(70_000) },
  });

  const event = await waitFor(async () => {
    const answer = await ctx.daemon.client.sendRequest('events.read', {});

    if (!Array.isArray(answer['events']) || !isRecord(answer['events'][0])) {
      throw new TypeError('no event yet');
    }

    return answer['events'][0];
  });

  const report = await ctx.daemon.client.sendRequest('report.get', { report: event['cursor'] });

  expect({ preview: event['detail'], text: report['text'] }).toStrictEqual({
    preview: `${'z'.repeat(599)}…`,
    text: `${'z'.repeat(65_533)}…`,
  });
});

test('it refuses a cursor at no trail row as an unknown report', async () => {
  await using ctx = await setupTest();

  const cursor = encodeCursor({ kind: 'events', id: 999_999 });

  expect(ctx.daemon.client.sendRequest('report.get', { report: cursor })).rejects.toMatchObject({
    code: 'bad_args',
    message: `no report '${cursor}'`,
  });
});

test('it refuses the cursor of an event that is not a report as an unknown report', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'SessionStart',
    payload: { session_id: 'c-1' },
  });

  // The session start is the trail's only event.
  const event = await waitFor(async () => {
    const answer = await ctx.daemon.client.sendRequest('events.read', {});

    if (!Array.isArray(answer['events']) || !isRecord(answer['events'][0])) {
      throw new TypeError('no event yet');
    }

    return answer['events'][0];
  });

  expect(
    ctx.daemon.client.sendRequest('report.get', { report: event['cursor'] }),
  ).rejects.toMatchObject({ code: 'bad_args', message: `no report '${String(event['cursor'])}'` });
});

test('it leaves a note from an unknown session out of the trail', async () => {
  await using ctx = await setupTest();

  const id = await spawnNamedSession(
    (m, p) => ctx.daemon.client.sendRequest(m, p),
    'one',
    ctx.daemon.dir,
  );

  await ctx.daemon.sendHookLines({
    atcId: 'nope',
    event: 'Report',
    payload: { kind: 'note', label: 'blocked', text: 'bogus' },
  });

  await ctx.daemon.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: { kind: 'note', label: 'blocked', text: 'valid' },
  });

  const read = await waitFor(async () => {
    const answer = await ctx.daemon.client.sendRequest('events.read', {});

    expect(answer['events']).toHaveLength(1);

    return answer;
  });

  expect(read).toStrictEqual({
    events: [
      {
        cursor: expect.toBeString(),
        at: expect.toBeNumber(),
        session: id,
        name: 'one',
        kind: 'report',
        detail: 'valid',
        label: 'blocked',
      },
    ],
    cursor: expect.toBeString(),
    more: false,
  });
});

test("it counts a note toward the session's last activity time", async () => {
  // The note's time runs a minute ahead of the session's creation.
  const clock = buildStubClock(Date.now() + 60_000);

  await using ctx = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }), clock }),
  });

  const id = await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'one', ctx.dir);

  await ctx.sendHookLines({
    atcId: id,
    event: 'Report',
    payload: { kind: 'note', label: 'blocked', text: 'need review' },
  });

  await waitFor(() => {
    expect(ctx.events).toPartiallyContain({ ev: 'SessionReport' });
  });

  const after = await ctx.client.sendRequest('session.get', { session: id });

  expect(after['lastActivityAt']).toBe(clock.now());
});

test('it gates a revived session on its own tap, not the tap its previous process attached', async () => {
  const claude = new ClaudeAdapter(buildMockAgentEntry({ id: 'claude' }), {
    authProfiles: new Map(),
  });

  // The first terminal ends once it reads a line of input; every later one
  // runs on.
  const planSpawn = mock(() => ({ bin: 'sleep', args: ['30'] })).mockReturnValueOnce({
    bin: 'head',
    args: ['-n', '1'],
  });

  await using ctx = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        normalizeHook: (hook) => claude.normalizeHook(hook),
        planSpawn,
      }),
      tapGraceMs: 0,
    }),
  });

  const id = await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'one', ctx.dir);

  await ctx.sendHookLines({ atcId: id, event: 'SessionStart', payload: { session_id: 'agent-1' } });

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  const tap = await ctx.openClient();

  await tap.sendRequest('session.tap', { session: id });
  await ctx.client.sendRequest('session.input', { session: id, d: 'end\r' });

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, alive: false });
  });

  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  await ctx.sendHookLines({ atcId: id, event: 'SessionStart', payload: { session_id: 'agent-1' } });

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, alive: true, lastMsg: 'revived' });
  });

  expect(
    ctx.client.sendRequest('session.message', { session: id, text: 'hello' }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it queues a message to a revived session before it reports SessionStart again', async () => {
  const claude = new ClaudeAdapter(buildMockAgentEntry({ id: 'claude' }), {
    authProfiles: new Map(),
  });

  // The first terminal ends once it reads a line of input; every later one
  // runs on.
  const planSpawn = mock(() => ({ bin: 'sleep', args: ['30'] })).mockReturnValueOnce({
    bin: 'head',
    args: ['-n', '1'],
  });

  await using ctx = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        normalizeHook: (hook) => claude.normalizeHook(hook),
        planSpawn,
      }),
      tapGraceMs: 0,
    }),
  });

  const id = await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'one', ctx.dir);

  await ctx.sendHookLines({ atcId: id, event: 'SessionStart', payload: { session_id: 'agent-1' } });

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  await ctx.client.sendRequest('session.input', { session: id, d: 'end\r' });

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, alive: false });
  });

  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const ok = await ctx.client.sendRequest('session.message', { session: id, text: 'hello' });

  expect(ok).toStrictEqual({ message: expect.stringMatching(/^m-/), status: 'accepted' });
});
