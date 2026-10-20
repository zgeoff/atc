import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, toSessionID } from '@atc/core';
import type { RestoreSettled } from '@atc/daemon';
import { ClaudeAdapter } from '@atc/harness-claude';
import { encodeCursor } from '@atc/protocol';
import type { DaemonEvent } from '@atc/protocol';
import { decodeMessage } from '@atc/protocol/wire';
import { StateStore } from '@atc/store';
import { buildMockFleetEntry } from '@atc/store/testing';
import {
  buildMockAgentAdapter,
  buildMockAgentEntry,
  buildMockHostServices,
  buildStubClock,
  getRecord,
  getString,
  registerTestCleanup,
  spawnNamedSession,
  startStubTap,
  subscribeToSocketLines,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

test('it accepts a message for a session that has not reported SessionStart', async () => {
  // The Claude adapter's own hook reading marks a session started.
  const claude = new ClaudeAdapter(
    buildMockAgentEntry({ id: 'claude' }),
    {
      authProfiles: new Map(),
    },
    buildMockHostServices(),
  );

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        planHookEvents: (hook) => claude.planHookEvents(hook),
      }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const ok = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  expect(ok).toStrictEqual({ message: expect.stringMatching(/^m-/u), status: 'queued' });
});

test('it queues a message to a started session within the start-up grace window', async () => {
  const clock = buildStubClock(0);

  const claude = new ClaudeAdapter(
    buildMockAgentEntry({ id: 'claude' }),
    {
      authProfiles: new Map(),
    },
    buildMockHostServices(),
  );

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        planHookEvents: (hook) => claude.planHookEvents(hook),
      }),
      clock,
      tapGraceMs: 300,
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.sendHookLines({
    atcId: id,
    event: 'SessionStart',
    payload: { session_id: 'agent-1' },
  });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  clock.advance(299);

  const ok = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  expect(ok).toStrictEqual({ message: expect.stringMatching(/^m-/u), status: 'queued' });
});

test('it refuses a message once the grace window passes with no tap ever attached', async () => {
  const clock = buildStubClock(0);

  const claude = new ClaudeAdapter(
    buildMockAgentEntry({ id: 'claude' }),
    {
      authProfiles: new Map(),
    },
    buildMockHostServices(),
  );

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        planHookEvents: (hook) => claude.planHookEvents(hook),
      }),
      clock,
      tapGraceMs: 300,
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.sendHookLines({
    atcId: id,
    event: 'SessionStart',
    payload: { session_id: 'agent-1' },
  });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  clock.advance(300);

  expect(
    daemon.client.sendRequest('session.message', { session: id, text: 'late' }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it accepts a message to a started session once a tap is connected', async () => {
  const claude = new ClaudeAdapter(
    buildMockAgentEntry({ id: 'claude' }),
    {
      authProfiles: new Map(),
    },
    buildMockHostServices(),
  );

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        planHookEvents: (hook) => claude.planHookEvents(hook),
      }),
      tapGraceMs: 0,
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.sendHookLines({
    atcId: id,
    event: 'SessionStart',
    payload: { session_id: 'agent-1' },
  });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  const tap = await daemon.openClient();

  await tap.sendRequest('session.tap', { session: id });

  const ok = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  expect(ok).toStrictEqual({ message: expect.stringMatching(/^m-/u), status: 'queued' });
});

test('it refuses a message to a session whose agent cannot take messages', async () => {
  const daemon = await startTestDaemon({
    options: () => {
      const adapter = buildMockAgentAdapter({ takesMessages: true });

      return { adapter, adapters: [adapter, buildMockAgentAdapter({ id: 'grok' })] };
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    name: 'grok-one',
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  expect(
    daemon.client.sendRequest('session.message', {
      session: getRecord(spawned, 'session')['id'],
      text: 'hello',
    }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it answers a message for an unknown session with no_such_session', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  expect(
    daemon.client.sendRequest('session.message', { session: 'nope', text: 'hello' }),
  ).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it answers a message for a killed session with session_dead', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.client.sendRequest('session.kill', { session: id });

  expect(
    daemon.client.sendRequest('session.message', { session: id, text: 'hello' }),
  ).rejects.toMatchObject({ code: 'session_dead' });
});

test('it rejects a message without text as bad_args', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  expect(daemon.client.sendRequest('session.message', { session: id })).rejects.toMatchObject({
    code: 'bad_args',
  });
});

test('it lists a session the fleet restore has not reached yet as waiting to restore', async () => {
  const daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      const stopSeed = registerTestCleanup(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-agent-a'), cwd: paths.directory }),
        buildMockFleetEntry({
          sessionID: toSessionID('s-agent-b'),
          name: 'b',
          cwd: paths.directory,
        }),
      ]);

      await stopSeed();

      return { adapter: buildMockAgentAdapter({ takesMessages: true }) };
    },
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed['sessions']).toPartiallyContain({
    id: 's-agent-b',
    name: 'b',
    lastMsg: 'waiting to restore',
  });
});

test('it queues a message for a session that waits for its restore boot after a restart', async () => {
  const clock = buildStubClock(0);

  const daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      const stopSeed = registerTestCleanup(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-agent-a'), cwd: paths.directory }),
        buildMockFleetEntry({ sessionID: toSessionID('s-agent-b'), cwd: paths.directory }),
        buildMockFleetEntry({ sessionID: toSessionID('s-agent-c'), cwd: paths.directory }),
      ]);

      await stopSeed();

      // The fake agent never reports it booted, so each later session
      // waits out the boot cap of the one before it on the stub clock.
      return {
        adapter: buildMockAgentAdapter({ takesMessages: true }),
        restoreFleetOnRestart: true,
        restoreBootTimeoutMs: 10,
        clock,
      };
    },
  });

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([10]);
  });

  const ok = await daemon.client.sendRequest('session.message', {
    session: 's-agent-c',
    text: 'hello',
  });

  expect(ok).toStrictEqual({ message: expect.stringMatching(/^m-/u), status: 'queued' });
});

test('it hands a message queued during the restore to the session tap that attaches after its boot', async () => {
  const clock = buildStubClock(0);
  const settles: RestoreSettled[] = [];

  const daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      const stopSeed = registerTestCleanup(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-agent-a'), cwd: paths.directory }),
        buildMockFleetEntry({ sessionID: toSessionID('s-agent-b'), cwd: paths.directory }),
        buildMockFleetEntry({ sessionID: toSessionID('s-agent-c'), cwd: paths.directory }),
      ]);

      await stopSeed();

      // The fake agent never reports it booted, so each later session
      // waits out the boot cap of the one before it on the stub clock.
      return {
        adapter: buildMockAgentAdapter({ takesMessages: true }),
        restoreFleetOnRestart: true,
        restoreBootTimeoutMs: 10,
        clock,
        onRestoreSettled: (settled) => {
          settles.push(settled);
        },
      };
    },
  });

  const tap = await daemon.openClient();

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([10]);
  });

  const sent = await daemon.client.sendRequest('session.message', {
    session: 's-agent-c',
    text: 'hello',
  });

  clock.advance(10);

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([10]);
  });

  clock.advance(10);

  await waitFor(() => {
    expect(settles).toStrictEqual([{ restored: 3, outcome: 'finished' }]);
  });

  const inbox = await startStubTap(tap, 's-agent-c');

  await waitFor(() => {
    expect<unknown[]>(inbox.messages).toStrictEqual([
      {
        ev: 'InboxMessage',
        sessionID: 's-agent-c',
        message: getString(sent, 'message'),
        from: 'owner',
        sender: { kind: 'owner', name: 'owner' },
        text: 'hello',
        sentAt: expect.any(Number),
      },
    ]);
  });
});

test('it drains pending messages to a tap in the order they were sent', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const first = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'one',
  });

  const second = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'two',
  });

  const third = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'three',
  });

  const inbox = await startStubTap(tap, id);

  await waitFor(() => {
    expect<unknown[]>(inbox.messages).toStrictEqual([
      {
        ev: 'InboxMessage',
        sessionID: id,
        message: getString(first, 'message'),
        from: 'owner',
        sender: { kind: 'owner', name: 'owner' },
        text: 'one',
        sentAt: expect.any(Number),
      },
      {
        ev: 'InboxMessage',
        sessionID: id,
        message: getString(second, 'message'),
        from: 'owner',
        sender: { kind: 'owner', name: 'owner' },
        text: 'two',
        sentAt: expect.any(Number),
      },
      {
        ev: 'InboxMessage',
        sessionID: id,
        message: getString(third, 'message'),
        from: 'owner',
        sender: { kind: 'owner', name: 'owner' },
        text: 'three',
        sentAt: expect.any(Number),
      },
    ]);
  });
});

test('it streams a message queued while the tap is connected', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const tapEvents: DaemonEvent[] = [];

  tap.onEvent = (event) => {
    tapEvents.push(event);
  };

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await tap.sendRequest('session.tap', { session: id });

  const ok = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'live',
  });

  await waitFor(() => {
    expect<unknown[]>(tapEvents.filter((event) => event.ev === 'InboxMessage')).toStrictEqual([
      {
        ev: 'InboxMessage',
        sessionID: id,
        message: getString(ok, 'message'),
        from: 'owner',
        sender: { kind: 'owner', name: 'owner' },
        text: 'live',
        sentAt: expect.any(Number),
      },
    ]);
  });
});

test('it drains two hundred pending messages to a tap with zero loss', async () => {
  // The drain's wait ends half a second before this test's 15 s timeout, so
  // a drain that stalls fails with the messages the tap got against the
  // ones sent, where the runner's timeout would report none.
  const deadline = Date.now() + 14_500;

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent: string[] = [];

  for (let index = 0; index < 200; index++) {
    const ok = await daemon.client.sendRequest('session.message', {
      session: id,
      text: `message ${index}`,
    });

    sent.push(getString(ok, 'message'));
  }

  const inbox = await startStubTap(tap, id);

  await waitFor(
    () => {
      expect(inbox.messages.map((event) => event.message)).toStrictEqual(sent);
    },
    { timeoutMs: Math.max(0, deadline - Date.now()) },
  );
}, 15_000);

test('it drains a backlog larger than the outbound queue without dropping the tap', async () => {
  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }), queueBytes: 4096 }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent: string[] = [];

  for (let index = 0; index < 12; index++) {
    const ok = await daemon.client.sendRequest('session.message', {
      session: id,
      text: `${index}`.padEnd(1500, 'x'),
    });

    sent.push(getString(ok, 'message'));
  }

  const tapClient = await daemon.openClient();
  const tap = await startStubTap(tapClient, id);

  await waitFor(() => {
    expect(tap.messages.map((event) => event.message)).toStrictEqual(sent);
  });
});

test('it refuses a tap on a session whose agent cannot take messages', async () => {
  const daemon = await startTestDaemon({
    options: () => {
      const adapter = buildMockAgentAdapter({ takesMessages: true });

      return { adapter, adapters: [adapter, buildMockAgentAdapter({ id: 'grok' })] };
    },
  });

  const tap = await daemon.openClient();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    name: 'grok-one',
    cwd: daemon.directory,
    agent: 'grok',
  });

  expect(
    tap.sendRequest('session.tap', { session: getRecord(spawned, 'session')['id'] }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it refuses a tap on an unknown session', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  expect(tap.sendRequest('session.tap', { session: 'nope' })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test('it moves an acked message to delivered', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await tap.sendRequest('session.tap', { session: id });

  const acked = await tap.sendRequest('message.ack', {
    session: id,
    message: sent['message'],
  });

  expect(acked).toStrictEqual({ message: sent['message'], status: 'delivered' });
});

test('it broadcasts SessionMessage for an acked message', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await tap.sendRequest('session.tap', { session: id });
  await tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  await waitFor(() => {
    expect<unknown[]>(daemon.events).toContainEqual({
      ev: 'SessionMessage',
      sessionID: id,
      message: getString(sent, 'message'),
      status: 'delivered',
      from: 'owner',
      sender: { kind: 'owner', name: 'owner' },
      textPreview: 'hello',
      sentAt: expect.any(Number),
      deliveredAt: expect.any(Number),
    });
  });
});

test('it refuses an ack from a connection that is not the session tap', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await tap.sendRequest('session.tap', { session: id });

  expect(
    daemon.client.sendRequest('message.ack', {
      session: id,
      message: sent['message'],
    }),
  ).rejects.toMatchObject({ code: 'bad_args' });
});

test('it answers a repeat ack with the current status', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await tap.sendRequest('session.tap', { session: id });
  await tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  const repeat = await tap.sendRequest('message.ack', {
    session: id,
    message: sent['message'],
  });

  expect(repeat).toStrictEqual({ message: sent['message'], status: 'delivered' });
});

test('it broadcasts delivered once for a repeat ack', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await tap.sendRequest('session.tap', { session: id });
  await tap.sendRequest('message.ack', { session: id, message: sent['message'] });
  await tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  // The daemon answers one connection's requests in order, so the ping's
  // answer follows every broadcast the acks made.
  await daemon.client.sendRequest('daemon.ping');

  expect<readonly Record<string, unknown>[]>(
    daemon.events.filter(
      (daemonEvent) => daemonEvent.ev === 'SessionMessage' && daemonEvent.status === 'delivered',
    ),
  ).toStrictEqual([
    {
      ev: 'SessionMessage',
      sessionID: id,
      message: getString(sent, 'message'),
      status: 'delivered',
      from: 'owner',
      sender: { kind: 'owner', name: 'owner' },
      textPreview: 'hello',
      sentAt: expect.any(Number),
      deliveredAt: expect.any(Number),
    },
  ]);
});

test('it rejects an ack of an unknown message as bad_args', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await tap.sendRequest('session.tap', { session: id });

  expect(
    tap.sendRequest('message.ack', { session: id, message: 'm-unknown' }),
  ).rejects.toMatchObject({ code: 'bad_args' });
});

test('it moves a message to answered from a Report line on the reporter socket', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer: 'done' },
  });

  await waitFor(() => {
    expect<unknown[]>(daemon.events).toContainEqual({
      ev: 'SessionMessage',
      sessionID: id,
      message: getString(sent, 'message'),
      status: 'answered',
      from: 'owner',
      sender: { kind: 'owner', name: 'owner' },
      textPreview: 'hello',
      sentAt: expect.any(Number),
      answeredAt: expect.any(Number),
      answerPreview: 'done',
    });
  });
});

test('it ignores an answer from another session', async () => {
  const ignored: [string, string][] = [];

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
      onNoteIgnored: (sessionID, kind) => {
        ignored.push([sessionID, kind]);
      },
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const other = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'two',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await daemon.sendHookLines({
    atcId: other,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer: 'bogus' },
  });

  await waitFor(() => {
    expect(ignored).toStrictEqual([[other, 'answered']]);
  });

  expect(
    daemon.events.filter(
      (daemonEvent) => daemonEvent.ev === 'SessionMessage' && daemonEvent.status === 'answered',
    ),
  ).toStrictEqual([]);
});

test('it keeps queueing messages after the tap connection drops', async () => {
  const claude = new ClaudeAdapter(
    buildMockAgentEntry({ id: 'claude' }),
    {
      authProfiles: new Map(),
    },
    buildMockHostServices(),
  );

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        planHookEvents: (hook) => claude.planHookEvents(hook),
      }),
      tapGraceMs: 0,
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.sendHookLines({
    atcId: id,
    event: 'SessionStart',
    payload: { session_id: 'agent-1' },
  });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  const tap = await daemon.openClient();

  await tap.sendRequest('session.tap', { session: id });
  await daemon.client.sendRequest('session.message', { session: id, text: 'while tapped' });

  tap.stop();

  // The daemon has let the tap go once it no longer counts the connection.
  await waitFor(() => {
    expect(daemon.daemon.countClients()).toBe(1);
  });

  const queued = await daemon.client.sendRequest('session.message', { session: id, text: 'after' });

  expect(queued).toStrictEqual({ message: expect.stringMatching(/^m-/u), status: 'queued' });
});

test('it refuses a message to a session whose process died even after a tap attached', async () => {
  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }), tapGraceMs: 0 }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const tap = await daemon.openClient();

  await tap.sendRequest('session.tap', { session: id });
  await daemon.client.sendRequest('session.kill', { session: id });

  expect(
    daemon.client.sendRequest('session.message', { session: id, text: 'hello' }),
  ).rejects.toMatchObject({ code: 'session_dead' });
});

test('it broadcasts SessionMessage on the events socket', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const subscriber = await subscribeToSocketLines(daemon.eventsSocketPath);

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  const line = await waitFor(() => {
    const found = subscriber.lines.find((candidate) => candidate.includes('"ev":"SessionMessage"'));

    expect(found).toBeString();

    return String(found);
  });

  const decoded = decodeMessage(line);

  expect(decoded).toStrictEqual({
    kind: 'event',
    message: {
      version: 7,
      ev: 'SessionMessage',
      sessionID: id,
      message: getString(sent, 'message'),
      status: 'queued',
      from: 'owner',
      sender: { kind: 'owner', name: 'owner' },
      textPreview: 'hello',
      sentAt: expect.any(Number),
    },
  });
});

test('it runs SessionMessage hooks with the event on stdin', async () => {
  const daemon = await startTestDaemon({
    options: (paths) => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
      hooks: {
        SessionMessage: [{ command: `cat >> '${join(paths.directory, 'hooks.log')}'` }],
        SessionNote: [{ command: `cat >> '${join(paths.directory, 'hooks.log')}'` }],
      },
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  const logged = await waitFor(() => {
    const text = readFileSync(join(daemon.directory, 'hooks.log'), 'utf8');

    expect(text).toEndWith('\n');

    return text;
  });

  const decoded = decodeMessage(logged);

  expect(decoded).toStrictEqual({
    kind: 'event',
    message: {
      version: 7,
      ev: 'SessionMessage',
      sessionID: id,
      message: getString(sent, 'message'),
      status: 'queued',
      from: 'owner',
      sender: { kind: 'owner', name: 'owner' },
      textPreview: 'hello',
      sentAt: expect.any(Number),
    },
  });
});

test('it broadcasts a note from the reporter socket as SessionNote', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'note', label: 'blocked', text: 'need review' },
  });

  await waitFor(() => {
    expect<unknown[]>(daemon.events).toContainEqual({
      ev: 'SessionNote',
      sessionID: id,
      kind: 'blocked',
      text: 'need review',
      sentAt: expect.any(Number),
    });
  });
});

test('it ignores a note from an unknown session', async () => {
  const ignored: [string, string][] = [];

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
      onNoteIgnored: (sessionID, kind) => {
        ignored.push([sessionID, kind]);
      },
    }),
  });

  await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.sendHookLines({
    atcId: 'nope',
    event: 'Note',
    payload: { kind: 'note', label: 'blocked', text: 'bogus' },
  });

  await waitFor(() => {
    expect(ignored).toStrictEqual([['nope', 'note']]);
  });

  expect(daemon.events.filter((daemonEvent) => daemonEvent.ev === 'SessionNote')).toStrictEqual([]);
});

test('it broadcasts SessionNote on the events socket', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const subscriber = await subscribeToSocketLines(daemon.eventsSocketPath);

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'note', label: 'progress', text: 'halfway' },
  });

  const line = await waitFor(() => {
    const found = subscriber.lines.find((candidate) => candidate.includes('"ev":"SessionNote"'));

    expect(found).toBeString();

    return String(found);
  });

  const decoded = decodeMessage(line);

  expect(decoded).toStrictEqual({
    kind: 'event',
    message: {
      version: 7,
      ev: 'SessionNote',
      sessionID: id,
      kind: 'progress',
      text: 'halfway',
      sentAt: expect.any(Number),
    },
  });
});

test('it runs SessionNote hooks with the event on stdin', async () => {
  const daemon = await startTestDaemon({
    options: (paths) => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
      hooks: {
        SessionMessage: [{ command: `cat >> '${join(paths.directory, 'hooks.log')}'` }],
        SessionNote: [{ command: `cat >> '${join(paths.directory, 'hooks.log')}'` }],
      },
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'note', label: 'decision', text: 'pick one' },
  });

  const logged = await waitFor(() => {
    const text = readFileSync(join(daemon.directory, 'hooks.log'), 'utf8');

    expect(text).toEndWith('\n');

    return text;
  });

  const decoded = decodeMessage(logged);

  expect(decoded).toStrictEqual({
    kind: 'event',
    message: {
      version: 7,
      ev: 'SessionNote',
      sessionID: id,
      kind: 'decision',
      text: 'pick one',
      sentAt: expect.any(Number),
    },
  });
});

test('it keeps InboxMessage off every connection but the tap', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const tapEvents: DaemonEvent[] = [];

  tap.onEvent = (event) => {
    tapEvents.push(event);
  };

  const subscriber = await subscribeToSocketLines(daemon.eventsSocketPath);

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await tap.sendRequest('session.tap', { session: id });
  await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  // The tap's copy shows the daemon has sent the message out.
  await waitFor(() => {
    expect(tapEvents).toPartiallyContain({ ev: 'InboxMessage' });
  });

  await daemon.client.sendRequest('daemon.ping');

  expect(daemon.events.map((daemonEvent) => daemonEvent.ev)).not.toContain('InboxMessage');
  expect(subscriber.lines.join('\n')).not.toInclude('InboxMessage');
});

test('it delivers pending messages to a new tap before a message queued at the same time', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const pending: Readonly<Record<string, unknown>>[] = [];

  for (let index = 0; index < 5; index++) {
    const ok = await daemon.client.sendRequest('session.message', {
      session: id,
      text: `${index}`,
    });

    pending.push(ok);
  }

  const [inbox, live] = await Promise.all([
    startStubTap(tap, id),
    daemon.client.sendRequest('session.message', { session: id, text: 'live' }),
  ]);

  await waitFor(() => {
    expect(inbox.messages.map((inboxMessage) => inboxMessage.message)).toStrictEqual(
      [...pending, live].map((ok) => getString(ok, 'message')),
    );
  });
});

test('it orders concurrently queued messages by their sent time', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const inbox = await startStubTap(tap, id);

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      daemon.client.sendRequest('session.message', { session: id, text: `${index}` }),
    ),
  );

  await waitFor(() => {
    expect(inbox.messages).toHaveLength(20);
  });

  const sentAt = inbox.messages.map((inboxMessage) => inboxMessage.sentAt);

  expect(sentAt).toStrictEqual(sentAt.toSorted((left, right) => left - right));

  expect(inbox.messages.map((inboxMessage) => inboxMessage.text)).toStrictEqual(
    Array.from({ length: 20 }, (_, index) => `${index}`),
  );
});

test('it reads a queued message back through message.get', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  const queued = await daemon.client.sendRequest('message.get', {
    message: sent['message'],
  });

  expect(queued).toStrictEqual({
    message: sent['message'],
    session: id,
    from: 'owner',
    sender: { kind: 'owner', name: 'owner' },
    text: 'hello',
    status: 'queued',
    sentAt: expect.any(Number),
    turn: null,
    answeredWith: [],
  });
});

test('it reads a delivered message back through message.get', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await tap.sendRequest('session.tap', { session: id });
  await tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  const delivered = await daemon.client.sendRequest('message.get', {
    message: sent['message'],
  });

  expect(delivered).toStrictEqual({
    message: sent['message'],
    session: id,
    from: 'owner',
    sender: { kind: 'owner', name: 'owner' },
    text: 'hello',
    status: 'delivered',
    sentAt: expect.any(Number),
    deliveredAt: expect.any(Number),
    turn: null,
    answeredWith: [],
  });
});

test('it reads an answered message back through message.get', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await tap.sendRequest('session.tap', { session: id });
  await tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer: 'done' },
  });

  await waitFor(async () => {
    const answered = await daemon.client.sendRequest('message.get', {
      message: sent['message'],
    });

    expect(answered).toStrictEqual({
      message: sent['message'],
      session: id,
      from: 'owner',
      sender: { kind: 'owner', name: 'owner' },
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
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const text = 't'.repeat(3000);
  const answer = 'a'.repeat(3000);

  const sent = await daemon.client.sendRequest('session.message', { session: id, text });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer },
  });

  await waitFor(() => {
    expect(daemon.events).toPartiallyContain({ ev: 'SessionMessage', status: 'answered' });
  });

  const got = await daemon.client.sendRequest('message.get', { message: sent['message'] });

  const broadcast = daemon.events.filter((daemonEvent) => daemonEvent.ev === 'SessionMessage');

  expect(got).toMatchObject({ text, answer });

  expect(broadcast).toSatisfyAll(
    (daemonEvent) => !('text' in daemonEvent) && !('answer' in daemonEvent),
  );

  expect(broadcast.map((daemonEvent) => daemonEvent.textPreview)).toSatisfyAll(
    (preview) => preview === `${'t'.repeat(599)}…`,
  );
});

test('it caps a stored answer at the byte limit without splitting a character', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  // Each 'é' is two bytes, and the cut that leaves room for the ellipsis
  // falls inside one.
  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer: 'é'.repeat(40_000) },
  });

  const got = await waitFor(async () => {
    const read = await daemon.client.sendRequest('message.get', { message: sent['message'] });

    expect(read['status']).toBe('answered');

    return read;
  });

  expect(got['answer']).toBe(`${'é'.repeat(32_766)}…`);
  expect(new TextEncoder().encode(String(got['answer']))).toHaveLength(65_535);
});

test('it gives two messages one turn answered the same turn and lists each beside the other', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const first = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'one',
  });

  const second = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'two',
  });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: {
      kind: 'answered',
      messages: [first['message'], second['message']],
      answer: 'both',
      turn: 't-1',
    },
  });

  await waitFor(async () => {
    const got = await daemon.client.sendRequest('message.get', { message: second['message'] });

    expect(got['status']).toBe('answered');
  });

  const firstGot = await daemon.client.sendRequest('message.get', {
    message: first['message'],
  });

  const secondGot = await daemon.client.sendRequest('message.get', {
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
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const first = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'one',
  });

  const second = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'two',
  });

  const third = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'three',
  });

  const pending = daemon.client.sendRequest('message.get', {
    message: first['message'],
    waitMs: 10_000,
  });

  // The daemon answers one connection's requests in the order they started,
  // so the ping's answer means the held read already took its first look.
  await daemon.client.sendRequest('daemon.ping');

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
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
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const first = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'one',
  });

  const second = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'two',
  });

  await daemon.sendHookLines(
    {
      atcId: id,
      event: 'Note',
      payload: { kind: 'answered', message: first['message'], answer: 'first', turn: 't-1' },
    },
    {
      atcId: id,
      event: 'Note',
      payload: { kind: 'answered', message: second['message'], answer: 'second', turn: 't-2' },
    },
  );

  await waitFor(async () => {
    const got = await daemon.client.sendRequest('message.get', { message: second['message'] });

    expect(got['status']).toBe('answered');
  });

  const firstGot = await daemon.client.sendRequest('message.get', {
    message: first['message'],
  });

  const secondGot = await daemon.client.sendRequest('message.get', {
    message: second['message'],
  });

  expect(firstGot).toMatchObject({ answer: 'first', turn: 't-1', answeredWith: [] });
  expect(secondGot).toMatchObject({ answer: 'second', turn: 't-2', answeredWith: [] });
});

test('it stores no turn for an answer reported without one', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const first = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'one',
  });

  const second = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'two',
  });

  await daemon.sendHookLines(
    {
      atcId: id,
      event: 'Note',
      payload: { kind: 'answered', message: first['message'], answer: 'both' },
    },
    {
      atcId: id,
      event: 'Note',
      payload: { kind: 'answered', message: second['message'], answer: 'both' },
    },
  );

  await waitFor(async () => {
    const got = await daemon.client.sendRequest('message.get', { message: second['message'] });

    expect(got['status']).toBe('answered');
  });

  const firstGot = await daemon.client.sendRequest('message.get', {
    message: first['message'],
  });

  const secondGot = await daemon.client.sendRequest('message.get', {
    message: second['message'],
  });

  expect(firstGot).toMatchObject({ answer: 'both', turn: null, answeredWith: [] });
  expect(secondGot).toMatchObject({ answer: 'both', turn: null, answeredWith: [] });
});

test("it answers one message of a running turn with the answer tool's text before the turn ends", async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const first = await daemon.client.sendRequest('session.message', { session: id, text: 'one' });
  const second = await daemon.client.sendRequest('session.message', { session: id, text: 'two' });

  await tap.sendRequest('session.tap', { session: id });
  await tap.sendRequest('message.ack', { session: id, message: first['message'] });
  await tap.sendRequest('message.ack', { session: id, message: second['message'] });
  await daemon.sendHookLines({ atcId: id, event: 'UserPromptSubmit', payload: {} });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'answered', message: first['message'], answer: 'the lighthouse is lit' },
  });

  await waitFor(async () => {
    const got = await daemon.client.sendRequest('message.get', { message: first['message'] });

    expect(got).toMatchObject({
      status: 'answered',
      answer: 'the lighthouse is lit',
      turn: null,
      answeredWith: [],
    });
  });

  const secondGot = await daemon.client.sendRequest('message.get', {
    message: second['message'],
  });

  expect(secondGot['status']).toBe('delivered');
});

test('it gives the final reply only to the message of a turn that the answer tool left unanswered', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const first = await daemon.client.sendRequest('session.message', { session: id, text: 'one' });
  const second = await daemon.client.sendRequest('session.message', { session: id, text: 'two' });

  await tap.sendRequest('session.tap', { session: id });
  await tap.sendRequest('message.ack', { session: id, message: first['message'] });
  await tap.sendRequest('message.ack', { session: id, message: second['message'] });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'answered', message: first['message'], answer: 'the lighthouse is lit' },
  });

  await waitFor(async () => {
    const got = await daemon.client.sendRequest('message.get', { message: first['message'] });

    expect(got['status']).toBe('answered');
  });

  // The turn's report holds both ids, as a report that crossed the answer
  // would, so the store alone keeps the first answer.
  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: {
      kind: 'answered',
      messages: [first['message'], second['message']],
      answer: 'the tide is out',
      turn: 't-1',
    },
  });

  await waitFor(async () => {
    const got = await daemon.client.sendRequest('message.get', { message: second['message'] });

    expect(got).toMatchObject({
      status: 'answered',
      answer: 'the tide is out',
      turn: 't-1',
      answeredWith: [],
    });
  });

  const firstGot = await daemon.client.sendRequest('message.get', { message: first['message'] });

  expect(firstGot).toMatchObject({
    status: 'answered',
    answer: 'the lighthouse is lit',
    turn: null,
    answeredWith: [],
  });
});

test('it holds message.get open until the message status changes', async () => {
  const clock = buildStubClock(0);

  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }), clock }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  const pending = daemon.client.sendRequest('message.get', {
    message: sent['message'],
    waitMs: 10_000,
  });

  // The held read waits on a timer for the rest of its window.
  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([10_000]);
  });

  const tap = await daemon.openClient();

  await tap.sendRequest('session.tap', { session: id });
  await tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  const got = await pending;

  expect(got).toStrictEqual({
    message: sent['message'],
    session: id,
    from: 'owner',
    sender: { kind: 'owner', name: 'owner' },
    text: 'hello',
    status: 'delivered',
    sentAt: expect.any(Number),
    deliveredAt: expect.any(Number),
    turn: null,
    answeredWith: [],
  });
});

test('it answers a held message.get with the unchanged status once the wait ends', async () => {
  const clock = buildStubClock(0);

  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }), clock }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  const pending = daemon.client.sendRequest('message.get', {
    message: sent['message'],
    waitMs: 300,
  });

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([300]);
  });

  clock.advance(300);

  const got = await pending;

  expect(got).toStrictEqual({
    message: sent['message'],
    session: id,
    from: 'owner',
    sender: { kind: 'owner', name: 'owner' },
    text: 'hello',
    status: 'queued',
    sentAt: expect.any(Number),
    turn: null,
    answeredWith: [],
  });
});

test('it answers message.get for an answered message at once whatever the wait', async () => {
  const clock = buildStubClock(0);

  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }), clock }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer: 'done' },
  });

  await waitFor(async () => {
    const got = await daemon.client.sendRequest('message.get', { message: sent['message'] });

    expect(got['status']).toBe('answered');
  });

  // The clock never moves, so only a read that waits on no timer answers.
  const got = await daemon.client.sendRequest('message.get', {
    message: sent['message'],
    waitMs: 10_000,
  });

  expect(got).toStrictEqual({
    message: sent['message'],
    session: id,
    from: 'owner',
    sender: { kind: 'owner', name: 'owner' },
    text: 'hello',
    status: 'answered',
    answer: 'done',
    sentAt: expect.any(Number),
    answeredAt: expect.any(Number),
    turn: null,
    answeredWith: [],
  });
});

test('it moves a delivered message to unanswered from an unanswered Note line', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await tap.sendRequest('session.tap', { session: id });
  await tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: {
      kind: 'unanswered',
      messages: [sent['message']],
      reason: 'interrupted',
      turn: 't-1',
    },
  });

  await waitFor(() => {
    expect<unknown[]>(daemon.events).toContainEqual({
      ev: 'SessionMessage',
      sessionID: id,
      message: getString(sent, 'message'),
      status: 'unanswered',
      from: 'owner',
      sender: { kind: 'owner', name: 'owner' },
      textPreview: 'hello',
      sentAt: expect.any(Number),
      deliveredAt: expect.any(Number),
      unansweredAt: expect.any(Number),
      unansweredReason: 'interrupted',
    });
  });
});

test('it reads an unanswered message back through message.get with its reason and turn', async () => {
  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'unanswered', messages: [sent['message']], reason: 'error', turn: 't-9' },
  });

  const got = await waitFor(async () => {
    const read = await daemon.client.sendRequest('message.get', { message: sent['message'] });

    expect(read['status']).toBe('unanswered');

    return read;
  });

  expect(got).toStrictEqual({
    message: sent['message'],
    session: id,
    from: 'owner',
    sender: { kind: 'owner', name: 'owner' },
    text: 'hello',
    status: 'unanswered',
    sentAt: expect.any(Number),
    unansweredAt: expect.any(Number),
    unansweredReason: 'error',
    turn: 't-9',
    answeredWith: [],
  });
});

test('it records an unanswered message in events.read', async () => {
  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'unanswered', messages: [sent['message']], reason: 'refusal' },
  });

  const read = await waitFor(async () => {
    const answer = await daemon.client.sendRequest('events.read', {});

    expect(answer['events']).toHaveLength(2);

    return answer;
  });

  expect(read['events']).toStrictEqual([
    expect.objectContaining({ kind: 'message-queued' }),
    {
      cursor: expect.toBeString(),
      at: expect.toBeNumber(),
      session: id,
      name: 'one',
      kind: 'message-unanswered',
      detail: 'hello',
      message: sent['message'],
    },
  ]);
});

test('it ignores an unanswered note from another session', async () => {
  const ignored: [string, string][] = [];

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
      onNoteIgnored: (sessionID, kind) => {
        ignored.push([sessionID, kind]);
      },
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const other = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'two',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  await daemon.sendHookLines({
    atcId: other,
    event: 'Note',
    payload: { kind: 'unanswered', messages: [sent['message']], reason: 'error' },
  });

  await waitFor(() => {
    expect(ignored).toStrictEqual([[other, 'unanswered']]);
  });

  const got = await daemon.client.sendRequest('message.get', { message: sent['message'] });

  expect(got['status']).toBe('queued');
});

test('it wakes a held message.get when the message turns unanswered', async () => {
  const clock = buildStubClock(0);

  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }), clock }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  const pending = daemon.client.sendRequest('message.get', {
    message: sent['message'],
    waitMs: 10_000,
  });

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([10_000]);
  });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'unanswered', messages: [sent['message']], reason: 'interrupted' },
  });

  const got = await pending;

  expect(got).toMatchObject({ status: 'unanswered', unansweredReason: 'interrupted' });
});

test('it answers message.get for an unanswered message at once whatever the wait', async () => {
  const clock = buildStubClock(0);

  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }), clock }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'unanswered', messages: [sent['message']], reason: 'error' },
  });

  await waitFor(async () => {
    const got = await daemon.client.sendRequest('message.get', { message: sent['message'] });

    expect(got['status']).toBe('unanswered');
  });

  // The clock never moves, so only a read that waits on no timer answers.
  const got = await daemon.client.sendRequest('message.get', {
    message: sent['message'],
    waitMs: 10_000,
  });

  expect(got['status']).toBe('unanswered');
});

test('it keeps a message unanswered when an answer arrives later', async () => {
  const ignored: [string, string][] = [];

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
      onNoteIgnored: (sessionID, kind) => {
        ignored.push([sessionID, kind]);
      },
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'unanswered', messages: [sent['message']], reason: 'interrupted' },
  });

  await waitFor(async () => {
    const got = await daemon.client.sendRequest('message.get', { message: sent['message'] });

    expect(got['status']).toBe('unanswered');
  });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer: 'late' },
  });

  await waitFor(() => {
    expect(ignored).toStrictEqual([[id, 'answered']]);
  });

  const got = await daemon.client.sendRequest('message.get', { message: sent['message'] });

  expect(got['status']).toBe('unanswered');
});

test('it rejects message.get for an unknown message as bad_args', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  expect(daemon.client.sendRequest('message.get', { message: 'm-unknown' })).rejects.toMatchObject({
    code: 'bad_args',
  });
});

test('it rejects message.get without a message as bad_args', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  expect(daemon.client.sendRequest('message.get', {})).rejects.toMatchObject({
    code: 'bad_args',
  });
});

test('it ends the earlier tap subscription when a second tap attaches', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const tapEvents: DaemonEvent[] = [];

  tap.onEvent = (event) => {
    tapEvents.push(event);
  };

  const replacement = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await tap.sendRequest('session.tap', { session: id });
  await replacement.sendRequest('session.tap', { session: id });

  await waitFor(() => {
    expect(tapEvents.filter((tapEvent) => tapEvent.ev === 'InboxClosed')).toStrictEqual([
      { ev: 'InboxClosed', sessionID: id, reason: 'replaced' },
    ]);
  });
});

test('it keeps the tap subscription when the same connection taps again', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const tapEvents: DaemonEvent[] = [];

  tap.onEvent = (event) => {
    tapEvents.push(event);
  };

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await tap.sendRequest('session.tap', { session: id });

  // The daemon sends a replaced tap its InboxClosed before it answers the
  // tap that replaced it, and here both are the same connection, so the
  // answer follows any such event.
  await tap.sendRequest('session.tap', { session: id });

  expect(tapEvents.filter((tapEvent) => tapEvent.ev === 'InboxClosed')).toStrictEqual([]);
});

test('it ends the tap subscription when its session is removed', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const tapEvents: DaemonEvent[] = [];

  tap.onEvent = (event) => {
    tapEvents.push(event);
  };

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await tap.sendRequest('session.tap', { session: id });

  // The first kill leaves an exited entry; the second removes it.
  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.kill', { session: id });

  await waitFor(() => {
    expect(tapEvents.filter((tapEvent) => tapEvent.ev === 'InboxClosed')).toStrictEqual([
      { ev: 'InboxClosed', sessionID: id, reason: 'removed' },
    ]);
  });
});

test('it records each message status change in events.read in order', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await tap.sendRequest('session.tap', { session: id });
  await tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer: 'done' },
  });

  const read = await waitFor(async () => {
    const answer = await daemon.client.sendRequest('events.read', {});

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
        kind: 'message-queued',
        detail: 'hello',
        message: getString(sent, 'message'),
      },
      {
        cursor: expect.toBeString(),
        at: expect.toBeNumber(),
        session: id,
        name: 'one',
        kind: 'message-delivered',
        detail: 'hello',
        message: getString(sent, 'message'),
      },
      {
        cursor: expect.toBeString(),
        at: expect.toBeNumber(),
        session: id,
        name: 'one',
        kind: 'message-answered',
        detail: 'done',
        message: getString(sent, 'message'),
      },
    ],
    cursor: expect.toBeString(),
    more: false,
  });
});

test('it records a repeated ack in the trail once', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await tap.sendRequest('session.tap', { session: id });
  await tap.sendRequest('message.ack', { session: id, message: sent['message'] });
  await tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  const read = await daemon.client.sendRequest('events.read', {});

  expect(read['events']).toStrictEqual([
    {
      cursor: expect.toBeString(),
      at: expect.toBeNumber(),
      session: id,
      name: 'one',
      kind: 'message-queued',
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
  ]);
});

test('it wakes a waiting events.read when a message is queued', async () => {
  const clock = buildStubClock(0);

  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }), clock }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const first = await daemon.client.sendRequest('events.read', {});

  const pending = daemon.client.sendRequest('events.read', {
    cursor: first['cursor'],
    waitMs: 10_000,
  });

  // The clock never moves, so only the new event ends the wait.
  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([10_000]);
  });

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });
  const woken = await pending;

  expect(woken['events']).toStrictEqual([
    {
      cursor: expect.toBeString(),
      at: expect.toBeNumber(),
      session: id,
      name: 'one',
      kind: 'message-queued',
      detail: 'hello',
      message: sent['message'],
    },
  ]);
});

test("it limits events.read to one session's events", async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const one = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const two = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'two',
    daemon.directory,
  );

  await daemon.client.sendRequest('session.message', { session: one, text: 'to one' });
  await daemon.client.sendRequest('session.message', { session: two, text: 'to two' });

  const read = await daemon.client.sendRequest('events.read', { session: two });

  expect(read).toStrictEqual({
    events: [
      {
        cursor: expect.toBeString(),
        at: expect.toBeNumber(),
        session: two,
        name: 'two',
        kind: 'message-queued',
        detail: 'to two',
        message: expect.toBeString(),
      },
    ],
    cursor: expect.toBeString(),
    more: false,
  });
});

test("it wakes a held events.read only for the filtered session's event", async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const one = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const two = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'two',
    daemon.directory,
  );

  const first = await daemon.client.sendRequest('events.read', {});

  const pending = daemon.client.sendRequest('events.read', {
    cursor: first['cursor'],
    session: two,
    waitMs: 10_000,
  });

  await daemon.client.sendRequest('session.message', { session: one, text: 'to one' });

  const sent = await daemon.client.sendRequest('session.message', {
    session: two,
    text: 'to two',
  });

  const woken = await pending;

  expect(woken['events']).toStrictEqual([
    {
      cursor: expect.toBeString(),
      at: expect.toBeNumber(),
      session: two,
      name: 'two',
      kind: 'message-queued',
      detail: 'to two',
      message: sent['message'],
    },
  ]);
});

test('it marks an events.read page that stopped before the end of the trail', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const start = await daemon.client.sendRequest('events.read', {});
  const firstSent = await daemon.client.sendRequest('session.message', { session: id, text: 'a' });
  const secondSent = await daemon.client.sendRequest('session.message', { session: id, text: 'b' });

  await daemon.client.sendRequest('session.message', { session: id, text: 'c' });

  const page = await daemon.client.sendRequest('events.read', {
    cursor: start['cursor'],
    limit: 2,
  });

  expect(page).toStrictEqual({
    events: [
      {
        cursor: expect.toBeString(),
        at: expect.toBeNumber(),
        session: id,
        name: 'one',
        kind: 'message-queued',
        detail: 'a',
        message: firstSent['message'],
      },
      {
        cursor: expect.toBeString(),
        at: expect.toBeNumber(),
        session: id,
        name: 'one',
        kind: 'message-queued',
        detail: 'b',
        message: secondSent['message'],
      },
    ],
    cursor: expect.toBeString(),
    more: true,
  });
});

test('it marks the events.read page that reaches the end of the trail as the last', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const start = await daemon.client.sendRequest('events.read', {});

  await daemon.client.sendRequest('session.message', { session: id, text: 'a' });
  await daemon.client.sendRequest('session.message', { session: id, text: 'b' });

  const lastSent = await daemon.client.sendRequest('session.message', { session: id, text: 'c' });

  const page = await daemon.client.sendRequest('events.read', {
    cursor: start['cursor'],
    limit: 2,
  });

  const rest = await daemon.client.sendRequest('events.read', {
    cursor: page['cursor'],
    limit: 2,
  });

  expect(rest).toStrictEqual({
    events: [
      {
        cursor: expect.toBeString(),
        at: expect.toBeNumber(),
        session: id,
        name: 'one',
        kind: 'message-queued',
        detail: 'c',
        message: lastSent['message'],
      },
    ],
    cursor: expect.toBeString(),
    more: false,
  });
});

test('it records a note in events.read with its label', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'note', label: 'blocked', text: 'need review' },
  });

  const read = await waitFor(async () => {
    const answer = await daemon.client.sendRequest('events.read', {});

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
        kind: 'note',
        detail: 'need review',
        label: 'blocked',
      },
    ],
    cursor: expect.toBeString(),
    more: false,
  });
});

test("it returns a note's whole text by the cursor of its event", async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'note', label: 'decision', text: 'y'.repeat(700) },
  });

  const event = await waitFor(async () => {
    const answer = await daemon.client.sendRequest('events.read', {});

    invariant(Array.isArray(answer['events']) && isRecord(answer['events'][0]), 'no event yet');

    return answer['events'][0];
  });

  const note = await daemon.client.sendRequest('note.get', { note: event['cursor'] });

  expect(event['detail']).toBe(`${'y'.repeat(599)}…`);

  expect(note).toStrictEqual({
    note: event['cursor'],
    at: event['at'],
    session: id,
    name: 'one',
    label: 'decision',
    text: 'y'.repeat(700),
    complete: true,
  });
});

test("it returns a note's text cut at 64 KiB", async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'note', label: 'evidence', text: 'z'.repeat(70_000) },
  });

  const event = await waitFor(async () => {
    const answer = await daemon.client.sendRequest('events.read', {});

    invariant(Array.isArray(answer['events']) && isRecord(answer['events'][0]), 'no event yet');

    return answer['events'][0];
  });

  const note = await daemon.client.sendRequest('note.get', { note: event['cursor'] });

  expect(event['detail']).toBe(`${'z'.repeat(599)}…`);
  expect(note['text']).toBe(`${'z'.repeat(65_533)}…`);
});

test('it refuses a cursor at no trail row as an unknown note', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const cursor = encodeCursor({ kind: 'events', id: 999_999 });

  expect(daemon.client.sendRequest('note.get', { note: cursor })).rejects.toMatchObject({
    code: 'bad_args',
    message: `no note '${cursor}'`,
  });
});

test('it refuses the cursor of an event that is not a note as an unknown note', async () => {
  // The Claude adapter's own hook reading marks a session started.
  const claude = new ClaudeAdapter(
    buildMockAgentEntry({ id: 'claude' }),
    {
      authProfiles: new Map(),
    },
    buildMockHostServices(),
  );

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        planHookEvents: (hook) => claude.planHookEvents(hook),
      }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.sendHookLines({
    atcId: id,
    event: 'SessionStart',
    payload: { session_id: 'c-1' },
  });

  // The session start is the trail's only event.
  const event = await waitFor(async () => {
    const answer = await daemon.client.sendRequest('events.read', {});

    invariant(Array.isArray(answer['events']) && isRecord(answer['events'][0]), 'no event yet');

    return answer['events'][0];
  });

  expect(daemon.client.sendRequest('note.get', { note: event['cursor'] })).rejects.toMatchObject({
    code: 'bad_args',
    message: `no note '${String(event['cursor'])}'`,
  });
});

test("it returns a message's whole answer by the cursor of its answered event", async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const answer = 'The parser keeps tabs. '.repeat(40);

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'does the parser keep tabs?',
  });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer },
  });

  const event = await waitFor(async () => {
    const read = await daemon.client.sendRequest('events.read', {});

    invariant(Array.isArray(read['events']), 'no events');

    const answered: unknown = read['events'].find(
      (entry: unknown) => isRecord(entry) && entry['kind'] === 'message-answered',
    );

    invariant(isRecord(answered), 'no answered event yet');

    return answered;
  });

  const got = await daemon.client.sendRequest('answer.get', { answer: event['cursor'] });

  expect(event['detail']).toBe(`${answer.slice(0, 599)}…`);

  expect(got).toStrictEqual({
    answer: event['cursor'],
    at: event['at'],
    session: id,
    name: 'one',
    message: sent['message'],
    text: answer,
    complete: true,
  });
});

test('it refuses the cursor of an event that is not an answered message as an unknown answer', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'note', label: 'progress', text: 'halfway through the parser' },
  });

  // The note is the trail's only event.
  const event = await waitFor(async () => {
    const read = await daemon.client.sendRequest('events.read', {});

    invariant(Array.isArray(read['events']) && isRecord(read['events'][0]), 'no event yet');

    return read['events'][0];
  });

  expect(
    daemon.client.sendRequest('answer.get', { answer: event['cursor'] }),
  ).rejects.toMatchObject({
    code: 'bad_args',
    message: `no answer '${String(event['cursor'])}'`,
  });
});

test('it leaves a note from an unknown session out of the trail', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.sendHookLines({
    atcId: 'nope',
    event: 'Note',
    payload: { kind: 'note', label: 'blocked', text: 'bogus' },
  });

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'note', label: 'blocked', text: 'valid' },
  });

  const read = await waitFor(async () => {
    const answer = await daemon.client.sendRequest('events.read', {});

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
        kind: 'note',
        detail: 'valid',
        label: 'blocked',
      },
    ],
    cursor: expect.toBeString(),
    more: false,
  });
});

test("it counts a note toward the session's last activity time", async () => {
  // The daemon's clock times the note, while the session takes its creation
  // time from the wall clock, so a clock set far past any wall-clock time
  // makes the note the session's latest activity.
  const clock = buildStubClock(Date.parse('2100-01-01T00:00:00Z'));

  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }), clock }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.sendHookLines({
    atcId: id,
    event: 'Note',
    payload: { kind: 'note', label: 'blocked', text: 'need review' },
  });

  await waitFor(() => {
    expect(daemon.events).toPartiallyContain({ ev: 'SessionNote' });
  });

  const after = await daemon.client.sendRequest('session.get', { session: id });

  expect(after['lastActivityAt']).toBe(clock.now());
});

test('it gates a revived session on its own tap, not the tap its previous process attached', async () => {
  const claude = new ClaudeAdapter(
    buildMockAgentEntry({ id: 'claude' }),
    {
      authProfiles: new Map(),
    },
    buildMockHostServices(),
  );

  // The first terminal ends once it reads a line of input; every later one
  // runs on.
  const planSpawn = mock(() => ({ bin: 'sleep', args: ['30'] })).mockReturnValueOnce({
    bin: 'head',
    args: ['-n', '1'],
  });

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        planHookEvents: (hook) => claude.planHookEvents(hook),
        planSpawn,
      }),
      tapGraceMs: 0,
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.sendHookLines({
    atcId: id,
    event: 'SessionStart',
    payload: { session_id: 'agent-1' },
  });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  const tap = await daemon.openClient();

  await tap.sendRequest('session.tap', { session: id });
  await daemon.client.sendRequest('session.input', { session: id, data: 'end\r' });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, alive: false });
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await daemon.sendHookLines({
    atcId: id,
    event: 'SessionStart',
    payload: { session_id: 'agent-1' },
  });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, alive: true, lastMsg: 'revived' });
  });

  expect(
    daemon.client.sendRequest('session.message', { session: id, text: 'hello' }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it queues a message to a revived session before it reports SessionStart again', async () => {
  const claude = new ClaudeAdapter(
    buildMockAgentEntry({ id: 'claude' }),
    {
      authProfiles: new Map(),
    },
    buildMockHostServices(),
  );

  // The first terminal ends once it reads a line of input; every later one
  // runs on.
  const planSpawn = mock(() => ({ bin: 'sleep', args: ['30'] })).mockReturnValueOnce({
    bin: 'head',
    args: ['-n', '1'],
  });

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        planHookEvents: (hook) => claude.planHookEvents(hook),
        planSpawn,
      }),
      tapGraceMs: 0,
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  await daemon.sendHookLines({
    atcId: id,
    event: 'SessionStart',
    payload: { session_id: 'agent-1' },
  });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  await daemon.client.sendRequest('session.input', { session: id, data: 'end\r' });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, alive: false });
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const ok = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  expect(ok).toStrictEqual({ message: expect.stringMatching(/^m-/u), status: 'queued' });
});

test('it marks a delivered message unanswered as session_ended when the process exits', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        planSpawn: () => ({ bin: 'head', args: ['-n', '1'] }),
      }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await tap.sendRequest('session.tap', { session: id });
  await tap.sendRequest('message.ack', { session: id, message: sent['message'] });
  await daemon.client.sendRequest('session.input', { session: id, data: 'end\r' });

  await waitFor(() => {
    expect<unknown[]>(daemon.events).toContainEqual({
      ev: 'SessionMessage',
      sessionID: id,
      message: getString(sent, 'message'),
      status: 'unanswered',
      from: 'owner',
      sender: { kind: 'owner', name: 'owner' },
      textPreview: 'hello',
      sentAt: expect.any(Number),
      deliveredAt: expect.any(Number),
      unansweredAt: expect.any(Number),
      unansweredReason: 'session_ended',
    });
  });
});

test('it marks a delivered message unanswered as session_ended when the session is killed', async () => {
  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  await tap.sendRequest('session.tap', { session: id });
  await tap.sendRequest('message.ack', { session: id, message: sent['message'] });
  await daemon.client.sendRequest('session.kill', { session: id });

  const got = await waitFor(async () => {
    const read = await daemon.client.sendRequest('message.get', { message: sent['message'] });

    expect(read['status']).toBe('unanswered');

    return read;
  });

  expect(got['unansweredReason']).toBe('session_ended');
});

test('it marks a delivered message unanswered as session_ended when the daemon restarts without a restore', async () => {
  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  await tap.sendRequest('session.tap', { session: id });
  await tap.sendRequest('message.ack', { session: id, message: sent['message'] });
  await daemon.restart();

  const read = await daemon.client.sendRequest('message.get', { message: sent['message'] });

  expect(read).toMatchObject({ status: 'unanswered', unansweredReason: 'session_ended' });
});

test('it marks a queued message unanswered as session_ended when the session is removed', async () => {
  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  // The first kill leaves an exited entry, whose next process could still
  // take the message; the second removes it.
  await daemon.client.sendRequest('session.kill', { session: id });

  const stopped = await daemon.client.sendRequest('message.get', { message: sent['message'] });

  expect(stopped['status']).toBe('queued');

  await daemon.client.sendRequest('session.kill', { session: id });

  await waitFor(async () => {
    const read = await daemon.client.sendRequest('message.get', { message: sent['message'] });

    expect(read).toMatchObject({ status: 'unanswered', unansweredReason: 'session_ended' });
  });
});

test('it keeps a delivered message delivered when another session of the same agent session ends', async () => {
  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  const tap = await daemon.openClient();

  const first = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    name: 'first',
    resume: 'agent-1',
    cols: 80,
    rows: 24,
  });

  const second = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    name: 'second',
    resume: 'agent-1',
    cols: 80,
    rows: 24,
  });

  const firstID = getRecord(first, 'session')['id'];
  const secondID = getRecord(second, 'session')['id'];

  const sent = await daemon.client.sendRequest('session.message', {
    session: secondID,
    text: 'hello',
  });

  await tap.sendRequest('session.tap', { session: secondID });
  await tap.sendRequest('message.ack', { session: secondID, message: sent['message'] });
  await daemon.client.sendRequest('session.kill', { session: firstID });
  await daemon.client.sendRequest('session.kill', { session: firstID });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed['sessions']).not.toPartiallyContain({ id: firstID });
  });

  const read = await daemon.client.sendRequest('message.get', { message: sent['message'] });

  expect(read['status']).toBe('delivered');
});

test('it marks a message unanswered as session_ended when its tap acks it after the process exited', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        planSpawn: () => ({ bin: 'head', args: ['-n', '1'] }),
      }),
    }),
  });

  const tap = await daemon.openClient();

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  await tap.sendRequest('session.tap', { session: id });
  await daemon.client.sendRequest('session.input', { session: id, data: 'end\r' });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, alive: false });
  });

  const acked = await tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  expect(acked).toStrictEqual({ message: sent['message'], status: 'unanswered' });
});

test('it keeps a queued message queued when the process exits', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        planSpawn: () => ({ bin: 'head', args: ['-n', '1'] }),
      }),
    }),
  });

  const id = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  await daemon.client.sendRequest('session.input', { session: id, data: 'end\r' });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, alive: false });
  });

  const read = await daemon.client.sendRequest('message.get', { message: sent['message'] });

  expect(read['status']).toBe('queued');
});

test.each([
  [
    'a request that acts as a principal, by the name beside it',
    {},
    ['client-7', 'Lantern Notes'],
    { kind: 'connector', client: 'client-7', name: 'Lantern Notes' },
  ],
  [
    'a request that acts as a principal without a name, by the principal',
    {},
    ['client-7'],
    { kind: 'connector', client: 'client-7', name: 'client-7' },
  ],
  [
    'a connection that acts as a principal, by the principal',
    { principal: 'client-7' },
    [],
    { kind: 'connector', client: 'client-7', name: 'client-7' },
  ],
  [
    'a request that acts as a principal on a connection that gives a session, by the name beside it',
    { session: 'sender' },
    ['client-7', 'Lantern Notes'],
    { kind: 'connector', client: 'client-7', name: 'Lantern Notes' },
  ],
  [
    'a connection that gives a session, by that session',
    { session: 'sender' },
    [],
    { kind: 'session', session: 'sender', name: 'harbor-refactor' },
  ],
  ['a connection that gives neither, as the owner', {}, [], { kind: 'owner', name: 'owner' }],
] as const)(
  'it labels a message from %s, whatever from the request gives',
  async (_caller, hello, as, sender) => {
    const daemon = await startTestDaemon({
      options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
    });

    const target = await spawnNamedSession(
      (method, params) => daemon.client.sendRequest(method, params),
      'target',
      daemon.directory,
    );

    const from = await spawnNamedSession(
      (method, params) => daemon.client.sendRequest(method, params),
      'harbor-refactor',
      daemon.directory,
    );

    // The hello's session placeholder stands for the sending session's id.
    const handshake = 'session' in hello ? { session: from } : hello;

    const client = await daemon.openClient(handshake);

    const sent = await client.sendRequest(
      'session.message',
      { session: target, text: 'check the tide tables', from: 'impostor' },
      ...as,
    );

    const read = await daemon.client.sendRequest('message.get', { message: sent['message'] });

    const expected = sender.kind === 'session' ? { ...sender, session: from } : sender;

    expect([read['from'], read['sender']]).toStrictEqual([expected.name, expected]);
  },
);
