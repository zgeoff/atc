import { expect, onTestFinished, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { spawnNamedSession } from '../../test/spawn-named-session';
import { subscribeToSocketLines } from '../../test/subscribe-to-socket-lines';
import { waitFor } from '../../test/wait-for';
import type { AgentAdapter } from '../agents/agent-adapter';
import { DaemonClient } from '../client/daemon-client';
import type { EventMsg } from '../protocol/protocol';
import { isRecord, sendReport } from '../shared/report';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import type { FleetEntry } from '../store/fleet-entry';
import { StateStore } from '../store/state-store';
import { startDaemon } from './daemon';

// Message-inbox behavior through the real daemon: acceptance rules, the tap
// stream, the status events, and the Report envelope on the reporter socket.
interface SetupOptions {
  readonly fleet?: readonly FleetEntry[];
  readonly queueBytes?: number;
  readonly tapGraceMs?: number;
}

async function setupTest(options: SetupOptions = {}) {
  const tmp = setupTempDir('atc-messages-');
  const dbPath = join(tmp.dir, 'state.db');
  const sockPath = join(tmp.dir, 'daemon.sock');
  const reporterPath = join(tmp.dir, 'reporter.sock');
  const eventsPath = join(tmp.dir, 'events.sock');
  const hookLog = join(tmp.dir, 'hooks.log');

  if (options.fleet !== undefined) {
    const seed = await StateStore.open(dbPath);

    await seed.writeFleet(options.fleet);
    await seed.stop();
  }

  const claude: AgentAdapter = {
    id: 'claude',
    headlessRunner: null,
    screenDetector: null,
    takesMessages: true,
    planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
    normalizeHook: (e) => {
      const sessionID = e.payload['session_id'];

      if (e.event === 'SessionStart' && typeof sessionID === 'string') {
        return { kind: 'started', agentSessionID: toAgentSessionID(sessionID) };
      }

      return { kind: 'heartbeat' };
    },
    loadName: () => Promise.resolve(null),
    canResume: () => true,
    buildResumeCommand: () => null,
  };

  const grok: AgentAdapter = {
    id: 'grok',
    headlessRunner: null,
    screenDetector: null,
    takesMessages: false,
    planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
    normalizeHook: () => ({ kind: 'heartbeat' }),
    loadName: () => Promise.resolve(null),
    canResume: () => true,
    buildResumeCommand: () => null,
  };

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: reporterPath,
    eventsSocketPath: eventsPath,
    build: 'atc/test-build',
    adapter: claude,
    adapters: [claude, grok],
    ...(options.queueBytes === undefined ? {} : { queueBytes: options.queueBytes }),
    ...(options.tapGraceMs === undefined ? {} : { tapGraceMs: options.tapGraceMs }),
    dbPath,
    statusPath: join(tmp.dir, 'status.json'),
    hooks: {
      SessionMessage: [{ command: `cat >> '${hookLog}'` }],
      SessionReport: [{ command: `cat >> '${hookLog}'` }],
    },
  });

  const events: EventMsg[] = [];
  const tapEvents: EventMsg[] = [];
  const tapClosed: EventMsg[] = [];

  const actor = await DaemonClient.open(sockPath);
  const tap = await DaemonClient.open(sockPath);

  actor.onEvent = (event) => {
    events.push(event);
  };

  // The tap connection also receives every broadcast event, so only the
  // tap-scoped stream is collected.
  tap.onEvent = (event) => {
    if (event.ev === 'InboxMessage') {
      tapEvents.push(event);
    }

    if (event.ev === 'InboxClosed') {
      tapClosed.push(event);
    }
  };

  await actor.sendHello('atc/test-build');
  await tap.sendHello('atc/test-build');

  return {
    dir: tmp.dir,
    sockPath,
    reporterPath,
    eventsPath,
    hookLog,
    actor,
    events,
    tap,
    tapEvents,
    tapClosed,
    async [Symbol.asyncDispose]() {
      // Live sessions are killed through the protocol first, so their fleet
      // rewrites land before the store closes under them.
      const listed = await actor.sendRequest('session.list');

      const sessions = Array.isArray(listed['sessions']) ? listed['sessions'] : [];

      for (const session of sessions) {
        if (isRecord(session) && session['alive'] === true) {
          await actor.sendRequest('session.kill', { session: session['id'] });
        }
      }

      actor.stop();
      tap.stop();

      await daemon.stop();
      await tmp[Symbol.asyncDispose]();
    },
  };
}

test('it accepts a message for a session that has not reported SessionStart', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  const ok = await daemon.actor.sendRequest('session.message', {
    session: id,
    text: 'hello',
    from: 'alice',
  });

  expect(ok).toStrictEqual({ message: expect.stringMatching(/^m-/), status: 'accepted' });
});

test('it queues a message to a started session within the start-up grace window', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await sendReport(
    daemon.reporterPath,
    `${JSON.stringify({ atcId: id, event: 'SessionStart', payload: { session_id: 'agent-1' } })}\n`,
    2000,
  );

  await waitFor(async () => {
    const listed = await daemon.actor.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  const ok = await daemon.actor.sendRequest('session.message', { session: id, text: 'hello' });

  expect(ok).toStrictEqual({ message: expect.stringMatching(/^m-/), status: 'accepted' });
});

test('it refuses a message once the grace window passes with no tap ever attached', async () => {
  await using daemon = await setupTest({ tapGraceMs: 300 });

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await sendReport(
    daemon.reporterPath,
    `${JSON.stringify({ atcId: id, event: 'SessionStart', payload: { session_id: 'agent-1' } })}\n`,
    2000,
  );

  await waitFor(async () => {
    const listed = await daemon.actor.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  const ok = await daemon.actor.sendRequest('session.message', { session: id, text: 'early' });

  expect(ok).toStrictEqual({ message: expect.stringMatching(/^m-/), status: 'accepted' });

  await waitFor(async () => {
    const [outcome] = await Promise.allSettled([
      daemon.actor.sendRequest('session.message', { session: id, text: 'late' }),
    ]);

    expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'unsupported' } });
  });
});

test('it accepts a message to a started session once a tap is connected', async () => {
  await using daemon = await setupTest({ tapGraceMs: 0 });

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await sendReport(
    daemon.reporterPath,
    `${JSON.stringify({ atcId: id, event: 'SessionStart', payload: { session_id: 'agent-1' } })}\n`,
    2000,
  );

  await waitFor(async () => {
    const listed = await daemon.actor.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  await daemon.tap.sendRequest('session.tap', { session: id });

  const ok = await daemon.actor.sendRequest('session.message', { session: id, text: 'hello' });

  expect(ok).toStrictEqual({ message: expect.stringMatching(/^m-/), status: 'accepted' });
});

test('it refuses a message to a session whose agent cannot take messages', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.actor.sendRequest('session.spawn', {
    cwd: '/tmp',
    name: 'grok-one',
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const descriptor = spawned['session'];

  if (!isRecord(descriptor)) {
    throw new TypeError('no session in spawn answer');
  }

  expect(
    daemon.actor.sendRequest('session.message', {
      session: descriptor['id'],
      text: 'hello',
    }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it answers a message for an unknown session with no_such_session', async () => {
  await using daemon = await setupTest();

  expect(
    daemon.actor.sendRequest('session.message', { session: 'nope', text: 'hello' }),
  ).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it answers a message for a killed session with session_dead', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await daemon.actor.sendRequest('session.kill', { session: id });

  expect(
    daemon.actor.sendRequest('session.message', { session: id, text: 'hello' }),
  ).rejects.toMatchObject({ code: 'session_dead' });
});

test('it rejects a message without text as bad_args', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  expect(daemon.actor.sendRequest('session.message', { session: id })).rejects.toMatchObject({
    code: 'bad_args',
  });
});

test('it queues a message for a session waiting to restore', async () => {
  await using daemon = await setupTest({
    fleet: [
      { name: 'a', cwd: '/tmp', agentSessionID: toAgentSessionID('agent-a'), agent: 'claude' },
      { name: 'b', cwd: '/tmp', agentSessionID: toAgentSessionID('agent-b'), agent: 'claude' },
    ],
  });

  await daemon.actor.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await daemon.actor.sendRequest('session.list');

  expect(listed['sessions']).toPartiallyContain({ name: 'b', lastMsg: 'waiting to restore' });

  const rawSessions = listed['sessions'];

  if (!Array.isArray(rawSessions)) {
    throw new TypeError('no session list');
  }

  const sessions: unknown[] = rawSessions;
  const second = sessions.find((s) => isRecord(s) && s['name'] === 'b');

  if (!isRecord(second)) {
    throw new TypeError('no restored session b');
  }

  const secondID: unknown = second['id'];

  const ok = await daemon.actor.sendRequest('session.message', {
    session: secondID,
    text: 'hello',
  });

  expect(ok).toStrictEqual({ message: expect.stringMatching(/^m-/), status: 'accepted' });
});

test('it drains pending messages to a tap in the order they were sent', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  const first = await daemon.actor.sendRequest('session.message', {
    session: id,
    text: 'one',
    from: 'alice',
  });

  const second = await daemon.actor.sendRequest('session.message', {
    session: id,
    text: 'two',
    from: 'alice',
  });

  const third = await daemon.actor.sendRequest('session.message', {
    session: id,
    text: 'three',
    from: 'alice',
  });

  await daemon.tap.sendRequest('session.tap', { session: id });

  for (const [i, sent] of [first, second, third].entries()) {
    await waitFor(() => {
      expect(daemon.tapEvents).toHaveLength(i + 1);
    });

    await daemon.tap.sendRequest('message.ack', { session: id, message: sent['message'] });
  }

  expect(daemon.tapEvents).toStrictEqual([
    {
      v: 3,
      ev: 'InboxMessage',
      s: id,
      message: first['message'],
      from: 'alice',
      text: 'one',
      sentAt: expect.any(Number),
    },
    {
      v: 3,
      ev: 'InboxMessage',
      s: id,
      message: second['message'],
      from: 'alice',
      text: 'two',
      sentAt: expect.any(Number),
    },
    {
      v: 3,
      ev: 'InboxMessage',
      s: id,
      message: third['message'],
      from: 'alice',
      text: 'three',
      sentAt: expect.any(Number),
    },
  ]);
});

test('it streams a message accepted while the tap is connected', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await daemon.tap.sendRequest('session.tap', { session: id });

  const ok = await daemon.actor.sendRequest('session.message', {
    session: id,
    text: 'live',
    from: 'bob',
  });

  await waitFor(() => {
    expect(daemon.tapEvents).toHaveLength(1);
  });

  expect(daemon.tapEvents).toStrictEqual([
    {
      v: 3,
      ev: 'InboxMessage',
      s: id,
      message: ok['message'],
      from: 'bob',
      text: 'live',
      sentAt: expect.any(Number),
    },
  ]);
});

test('it drains two hundred pending messages to a tap with zero loss', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  const sent: unknown[] = [];

  for (let i = 0; i < 200; i++) {
    const ok = await daemon.actor.sendRequest('session.message', {
      session: id,
      text: `message ${i}`,
    });

    sent.push(ok['message']);
  }

  await daemon.tap.sendRequest('session.tap', { session: id });

  for (const [i, messageID] of sent.entries()) {
    await waitFor(() => {
      expect(daemon.tapEvents).toHaveLength(i + 1);
    });

    await daemon.tap.sendRequest('message.ack', { session: id, message: messageID });
  }

  expect(daemon.tapEvents.map((e) => e['message'])).toStrictEqual(sent);
});

test('it drains a backlog larger than the outbound queue without dropping the tap', async () => {
  await using daemon = await setupTest({ queueBytes: 4096 });

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  const sent: unknown[] = [];

  for (let i = 0; i < 12; i++) {
    const ok = await daemon.actor.sendRequest('session.message', {
      session: id,
      text: `${i}`.padEnd(1500, 'x'),
    });

    sent.push(ok['message']);
  }

  await daemon.tap.sendRequest('session.tap', { session: id });

  for (const [i, messageID] of sent.entries()) {
    await waitFor(() => {
      expect(daemon.tapEvents).toHaveLength(i + 1);
    });

    await daemon.tap.sendRequest('message.ack', { session: id, message: messageID });
  }

  expect(daemon.tapEvents.map((e) => e['message'])).toStrictEqual(sent);
});

test('it refuses a tap on a session whose agent cannot take messages', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.actor.sendRequest('session.spawn', {
    name: 'grok-one',
    cwd: '/tmp',
    agent: 'grok',
  });

  const descriptor = spawned['session'];

  if (!isRecord(descriptor)) {
    throw new TypeError('no session in spawn answer');
  }

  expect(
    daemon.tap.sendRequest('session.tap', { session: descriptor['id'] }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it refuses a tap on an unknown session', async () => {
  await using daemon = await setupTest();

  expect(daemon.tap.sendRequest('session.tap', { session: 'nope' })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test('it moves an acked message to delivered and broadcasts SessionMessage', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  const sent = await daemon.actor.sendRequest('session.message', {
    session: id,
    text: 'hello',
    from: 'alice',
  });

  await daemon.tap.sendRequest('session.tap', { session: id });

  const acked = await daemon.tap.sendRequest('message.ack', {
    session: id,
    message: sent['message'],
  });

  expect(acked).toStrictEqual({ message: sent['message'], status: 'delivered' });

  await waitFor(() => {
    expect(daemon.events).toContainEqual({
      v: 3,
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
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');
  const sent = await daemon.actor.sendRequest('session.message', { session: id, text: 'hello' });

  await daemon.tap.sendRequest('session.tap', { session: id });

  expect(
    daemon.actor.sendRequest('message.ack', {
      session: id,
      message: sent['message'],
    }),
  ).rejects.toMatchObject({ code: 'bad_args' });
});

test('it answers a repeat ack with the current status and broadcasts delivered once', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');
  const sent = await daemon.actor.sendRequest('session.message', { session: id, text: 'hello' });

  await daemon.tap.sendRequest('session.tap', { session: id });
  await daemon.tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  const repeat = await daemon.tap.sendRequest('message.ack', {
    session: id,
    message: sent['message'],
  });

  await daemon.actor.sendRequest('daemon.ping');

  expect(repeat).toStrictEqual({ message: sent['message'], status: 'delivered' });

  expect(
    daemon.events.filter((e) => e.ev === 'SessionMessage' && e['status'] === 'delivered'),
  ).toHaveLength(1);
});

test('it rejects an ack of an unknown message as bad_args', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await daemon.tap.sendRequest('session.tap', { session: id });

  expect(
    daemon.tap.sendRequest('message.ack', { session: id, message: 'm-unknown' }),
  ).rejects.toMatchObject({ code: 'bad_args' });
});

test('it moves a message to answered from a Report line on the reporter socket', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  const sent = await daemon.actor.sendRequest('session.message', {
    session: id,
    text: 'hello',
    from: 'alice',
  });

  await sendReport(
    daemon.reporterPath,
    `${JSON.stringify({ atcId: id, event: 'Report', payload: { kind: 'answered', message: sent['message'], answer: 'done' } })}\n`,
    2000,
  );

  await waitFor(() => {
    expect(daemon.events).toContainEqual({
      v: 3,
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
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');
  const other = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'two', '/tmp');
  const sent = await daemon.actor.sendRequest('session.message', { session: id, text: 'hello' });

  await sendReport(
    daemon.reporterPath,
    `${JSON.stringify({ atcId: other, event: 'Report', payload: { kind: 'answered', message: sent['message'], answer: 'bogus' } })}\n`,
    2000,
  );

  await sendReport(
    daemon.reporterPath,
    `${JSON.stringify({ atcId: id, event: 'Report', payload: { kind: 'answered', message: sent['message'], answer: 'valid' } })}\n`,
    2000,
  );

  await waitFor(() => {
    expect(daemon.events).toPartiallyContain({ ev: 'SessionMessage', status: 'answered' });
  });

  const answered = daemon.events.filter(
    (e) => e.ev === 'SessionMessage' && e['status'] === 'answered',
  );

  expect(answered).toHaveLength(1);
  expect(answered[0]).toMatchObject({ s: id, answerPreview: 'valid' });
});

test('it keeps queueing messages after the tap connection drops', async () => {
  await using daemon = await setupTest({ tapGraceMs: 0 });

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await sendReport(
    daemon.reporterPath,
    `${JSON.stringify({ atcId: id, event: 'SessionStart', payload: { session_id: 'agent-1' } })}\n`,
    2000,
  );

  await waitFor(async () => {
    const listed = await daemon.actor.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  await daemon.tap.sendRequest('session.tap', { session: id });
  await daemon.actor.sendRequest('session.message', { session: id, text: 'while tapped' });

  daemon.tap.stop();

  const queued = await waitFor(() =>
    daemon.actor.sendRequest('session.message', { session: id, text: 'after' }),
  );

  expect(queued).toStrictEqual({ message: expect.stringMatching(/^m-/), status: 'accepted' });
});

test('it refuses a message to a session whose process died even after a tap attached', async () => {
  await using daemon = await setupTest({ tapGraceMs: 0 });

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await daemon.tap.sendRequest('session.tap', { session: id });
  await daemon.actor.sendRequest('session.kill', { session: id });

  expect(
    daemon.actor.sendRequest('session.message', { session: id, text: 'hello' }),
  ).rejects.toMatchObject({ code: 'session_dead' });
});

test('it broadcasts SessionMessage on the events socket', async () => {
  await using daemon = await setupTest();
  await using subscriber = await subscribeToSocketLines(daemon.eventsPath);

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await daemon.actor.sendRequest('session.message', { session: id, text: 'hello' });

  await waitFor(() => {
    expect(subscriber.lines.join('\n')).toInclude('"ev":"SessionMessage"');
  });
});

test('it runs SessionMessage hooks with the event on stdin', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await daemon.actor.sendRequest('session.message', { session: id, text: 'hello' });

  await waitFor(() => {
    expect(readFileSync(daemon.hookLog, 'utf8')).toInclude('"status":"accepted"');
  });
});

test('it broadcasts a note from the reporter socket as SessionReport', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await sendReport(
    daemon.reporterPath,
    `${JSON.stringify({ atcId: id, event: 'Report', payload: { kind: 'note', label: 'blocked', text: 'need review' } })}\n`,
    2000,
  );

  await waitFor(() => {
    expect(daemon.events).toContainEqual({
      v: 3,
      ev: 'SessionReport',
      s: id,
      kind: 'blocked',
      text: 'need review',
      reportedAt: expect.any(Number),
    });
  });
});

test('it ignores a note from an unknown session', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await sendReport(
    daemon.reporterPath,
    `${JSON.stringify({ atcId: 'nope', event: 'Report', payload: { kind: 'note', label: 'blocked', text: 'bogus' } })}\n`,
    2000,
  );

  await sendReport(
    daemon.reporterPath,
    `${JSON.stringify({ atcId: id, event: 'Report', payload: { kind: 'note', label: 'blocked', text: 'valid' } })}\n`,
    2000,
  );

  await waitFor(() => {
    expect(daemon.events).toPartiallyContain({ ev: 'SessionReport' });
  });

  const reported = daemon.events.filter((e) => e.ev === 'SessionReport');

  expect(reported).toHaveLength(1);
  expect(reported[0]).toMatchObject({ s: id, text: 'valid' });
});

test('it broadcasts SessionReport on the events socket', async () => {
  await using daemon = await setupTest();
  await using subscriber = await subscribeToSocketLines(daemon.eventsPath);

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await sendReport(
    daemon.reporterPath,
    `${JSON.stringify({ atcId: id, event: 'Report', payload: { kind: 'note', label: 'progress', text: 'halfway' } })}\n`,
    2000,
  );

  await waitFor(() => {
    expect(subscriber.lines.join('\n')).toInclude('"ev":"SessionReport"');
  });
});

test('it runs SessionReport hooks with the event on stdin', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await sendReport(
    daemon.reporterPath,
    `${JSON.stringify({ atcId: id, event: 'Report', payload: { kind: 'note', label: 'decision', text: 'pick one' } })}\n`,
    2000,
  );

  await waitFor(() => {
    expect(readFileSync(daemon.hookLog, 'utf8')).toInclude('"ev":"SessionReport"');
  });
});

test('it keeps InboxMessage off every connection but the tap', async () => {
  await using daemon = await setupTest();
  await using subscriber = await subscribeToSocketLines(daemon.eventsPath);

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await daemon.tap.sendRequest('session.tap', { session: id });
  await daemon.actor.sendRequest('session.message', { session: id, text: 'hello' });

  await waitFor(() => {
    expect(daemon.tapEvents).toHaveLength(1);
  });

  await daemon.actor.sendRequest('daemon.ping');

  expect(daemon.events.map((e) => e.ev)).not.toContain('InboxMessage');
  expect(subscriber.lines.join('\n')).not.toInclude('InboxMessage');
});

test('it delivers pending messages to a new tap before a message accepted at the same time', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  const sent: unknown[] = [];

  for (let i = 0; i < 5; i++) {
    const ok = await daemon.actor.sendRequest('session.message', { session: id, text: `${i}` });

    sent.push(ok['message']);
  }

  const [, live] = await Promise.all([
    daemon.tap.sendRequest('session.tap', { session: id }),
    daemon.actor.sendRequest('session.message', { session: id, text: 'live' }),
  ]);

  sent.push(live['message']);

  for (const [i, messageID] of sent.entries()) {
    await waitFor(() => {
      expect(daemon.tapEvents.length).toBeGreaterThan(i);
    });

    await daemon.tap.sendRequest('message.ack', { session: id, message: messageID });
  }

  expect(daemon.tapEvents.map((e) => e['message'])).toStrictEqual(sent);
});

test('it orders concurrently accepted messages by their sent time', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await daemon.tap.sendRequest('session.tap', { session: id });

  const accepted = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      daemon.actor.sendRequest('session.message', { session: id, text: `${i}` }),
    ),
  );

  for (const [i, ok] of accepted.entries()) {
    await waitFor(() => {
      expect(daemon.tapEvents.length).toBeGreaterThan(i);
    });

    await daemon.tap.sendRequest('message.ack', { session: id, message: ok['message'] });
  }

  expect(daemon.tapEvents.map((e) => e['sentAt'])).toStrictEqual(
    daemon.tapEvents.map((e) => e['sentAt']).toSorted((a, b) => Number(a) - Number(b)),
  );

  expect(daemon.tapEvents.map((e) => e['text'])).toStrictEqual(accepted.map((_, i) => `${i}`));
});

test('it reads a message back through message.get at each status', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  const sent = await daemon.actor.sendRequest('session.message', {
    session: id,
    text: 'hello',
    from: 'alice',
  });

  const accepted = await daemon.actor.sendRequest('message.get', { message: sent['message'] });

  expect(accepted).toStrictEqual({
    message: sent['message'],
    session: id,
    from: 'alice',
    text: 'hello',
    status: 'accepted',
    sentAt: expect.any(Number),
  });

  await daemon.tap.sendRequest('session.tap', { session: id });
  await daemon.tap.sendRequest('message.ack', { session: id, message: sent['message'] });

  const delivered = await daemon.actor.sendRequest('message.get', { message: sent['message'] });

  expect(delivered).toStrictEqual({
    message: sent['message'],
    session: id,
    from: 'alice',
    text: 'hello',
    status: 'delivered',
    sentAt: expect.any(Number),
    deliveredAt: expect.any(Number),
  });

  await sendReport(
    daemon.reporterPath,
    `${JSON.stringify({ atcId: id, event: 'Report', payload: { kind: 'answered', message: sent['message'], answer: 'done' } })}\n`,
    2000,
  );

  await waitFor(async () => {
    const answered = await daemon.actor.sendRequest('message.get', { message: sent['message'] });

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
    });
  });
});

test('it returns the full text and answer through message.get while the event carries previews', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  const text = 't'.repeat(3000);
  const answer = 'a'.repeat(3000);

  const sent = await daemon.actor.sendRequest('session.message', { session: id, text });

  await sendReport(
    daemon.reporterPath,
    `${JSON.stringify({ atcId: id, event: 'Report', payload: { kind: 'answered', message: sent['message'], answer } })}\n`,
    2000,
  );

  await waitFor(() => {
    expect(daemon.events).toPartiallyContain({ ev: 'SessionMessage', status: 'answered' });
  });

  const got = await daemon.actor.sendRequest('message.get', { message: sent['message'] });

  const broadcast = daemon.events.filter((e) => e.ev === 'SessionMessage');

  expect(got).toMatchObject({ text, answer });
  expect(broadcast).toSatisfyAll((e) => !('text' in e) && !('answer' in e));
  expect(broadcast.map((e) => e['textPreview'])).toSatisfyAll((p) => p === `${'t'.repeat(599)}…`);
});

test('it caps a stored answer at the byte limit without splitting a character', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');
  const sent = await daemon.actor.sendRequest('session.message', { session: id, text: 'hello' });

  // Each 'é' is two bytes, and the cut that leaves room for the ellipsis
  // falls inside one.
  await sendReport(
    daemon.reporterPath,
    `${JSON.stringify({ atcId: id, event: 'Report', payload: { kind: 'answered', message: sent['message'], answer: 'é'.repeat(40_000) } })}\n`,
    2000,
  );

  await waitFor(async () => {
    const got = await daemon.actor.sendRequest('message.get', { message: sent['message'] });

    expect(got['status']).toBe('answered');
  });

  const got = await daemon.actor.sendRequest('message.get', { message: sent['message'] });

  expect(got['answer']).toBe(`${'é'.repeat(32_766)}…`);
  expect(new TextEncoder().encode(String(got['answer']))).toHaveLength(65_535);
});

test('it rejects message.get for an unknown message as bad_args', async () => {
  await using daemon = await setupTest();

  expect(daemon.actor.sendRequest('message.get', { message: 'm-unknown' })).rejects.toMatchObject({
    code: 'bad_args',
  });
});

test('it rejects message.get without a message as bad_args', async () => {
  await using daemon = await setupTest();

  expect(daemon.actor.sendRequest('message.get', {})).rejects.toMatchObject({
    code: 'bad_args',
  });
});

test('it ends the earlier tap subscription when a second tap attaches', async () => {
  await using daemon = await setupTest();

  const replacement = await DaemonClient.open(daemon.sockPath);

  onTestFinished(() => {
    replacement.stop();
  });

  await replacement.sendHello('atc/test-build');

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await daemon.tap.sendRequest('session.tap', { session: id });
  await replacement.sendRequest('session.tap', { session: id });

  await waitFor(() => {
    expect(daemon.tapClosed).toStrictEqual([
      { v: 3, ev: 'InboxClosed', s: id, reason: 'replaced' },
    ]);
  });
});

test('it keeps the tap subscription when the same connection taps again', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await daemon.tap.sendRequest('session.tap', { session: id });
  await daemon.tap.sendRequest('session.tap', { session: id });
  await daemon.actor.sendRequest('daemon.ping');
  await daemon.tap.sendRequest('daemon.ping');

  expect(daemon.tapClosed).toStrictEqual([]);
});

test('it ends the tap subscription when its session is removed', async () => {
  await using daemon = await setupTest();

  const id = await spawnNamedSession((m, p) => daemon.actor.sendRequest(m, p), 'one', '/tmp');

  await daemon.tap.sendRequest('session.tap', { session: id });

  // The first kill leaves an exited entry; the second removes it.
  await daemon.actor.sendRequest('session.kill', { session: id });
  await daemon.actor.sendRequest('session.kill', { session: id });

  await waitFor(() => {
    expect(daemon.tapClosed).toStrictEqual([{ v: 3, ev: 'InboxClosed', s: id, reason: 'removed' }]);
  });
});
