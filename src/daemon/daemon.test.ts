import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { GrokAdapter } from '../agents/grok-adapter';
import { DaemonClient } from '../client/daemon-client';
import { encodeCursor } from '../protocol/encode-cursor';
import { parseConfig } from '../shared/config';
import { getRecord } from '../shared/get-record';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildStubClock } from '../test-utils/build-stub-clock';
import { getAgentEntry } from '../test-utils/get-agent-entry';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { spawnNamedSession } from '../test-utils/spawn-named-session';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { subscribeToSocketLines } from '../test-utils/subscribe-to-socket-lines';
import { waitFor } from '../test-utils/wait-for';

/**
 * A real daemon whose Claude adapter is a stand-in that idles, with a main
 * client that has sent its handshake and collects every event it receives.
 */
function setupTest() {
  return startTestDaemon({
    prefix: 'atc-daemon-',

    // Every spawn needs a Claude adapter; this one runs a sleep.
    options: () => ({ adapter: buildMockAgentAdapter() }),
  });
}

test('it answers daemon.hello with the build, limits, and features', async () => {
  const ctx = await setupTest();
  const client = await DaemonClient.open(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  const ok = await client.sendHello('atc/test-build');

  expect(ok).toStrictEqual({
    daemon: ctx.build,
    daemonID: expect.stringMatching(/^[\da-f-]{36}$/),
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    features: [
      'agents.list',
      'events.more',
      'events.session',
      'message.turn',
      'message.wait',
      'spawn.options',
      'daemon.id',
      'session.locator',
      'spawn.idempotency',
      'message.idempotency',
      'spawn.target',
      'request.principal',
      'spawn.workspace',
      'spawn.workspace.trust',
      'spawn.workspace.autoDir',
      'session.forget',
      'session.forget.preconditions',
      'session.submit',
      'report.get',
      'sources',
      'git.probe',
      'transport.tcp',
      'idempotency.replayOnly',
      'session.auth',
    ],
    idempotency: { completedRetentionMs: 86_400_000 },
    lastUsedAgent: 'claude',
  });
});

test('it counts a client connection while it is open', async () => {
  const ctx = await setupTest();

  expect(ctx.daemon.countClients()).toBe(1);
});

test('it stops counting a client connection once it closes', async () => {
  const ctx = await setupTest();

  ctx.client.stop();

  await waitFor(() => {
    expect(ctx.daemon.countClients()).toBe(0);
  });
});

test('it rejects a protocol version mismatch naming both builds and closes the connection', async () => {
  const ctx = await setupTest();
  const raw = await subscribeToSocketLines(ctx.socketPath);

  raw.write('{"v":5,"id":1,"m":"daemon.hello","p":{"client":"atc/newer-build"}}\n');

  await raw.closed;

  expect(raw.lines.map((line): unknown => JSON.parse(line))).toStrictEqual([
    {
      v: 4,
      id: 1,
      err: {
        code: 'protocol_mismatch',
        msg: 'atc/newer-build speaks protocol v5, daemon atc/test-build speaks v4; restart the daemon so both run the same build',
      },
    },
  ]);
});

test('it answers daemon.ping after the handshake', async () => {
  const ctx = await setupTest();
  const pong = await ctx.client.sendRequest('daemon.ping');

  expect(pong).toStrictEqual({});
});

test('it refuses any request before daemon.hello', async () => {
  const ctx = await setupTest();
  const client = await DaemonClient.open(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  expect(client.sendRequest('daemon.ping')).rejects.toMatchObject({ code: 'unauthorized' });
});

test('it answers an unknown method with unknown_method', async () => {
  const ctx = await setupTest();

  expect(ctx.client.sendRequest('session.levitate')).rejects.toMatchObject({
    code: 'unknown_method',
  });
});

test('it stays connected after answering an unknown method', async () => {
  const ctx = await setupTest();

  await ctx.client.sendRequest('session.levitate').catch(() => null);

  const pong = await ctx.client.sendRequest('daemon.ping');

  expect(pong).toStrictEqual({});
});

test('it closes the connection on a malformed line', async () => {
  const ctx = await setupTest();
  const raw = await subscribeToSocketLines(ctx.socketPath);

  raw.write('this is not json\n');

  await raw.closed;

  expect(raw.lines.map((line): unknown => JSON.parse(line))).toStrictEqual([
    { v: 4, id: 0, err: { code: 'bad_args', msg: 'malformed line: not valid JSON' } },
  ]);
});

test('it closes the connection on an oversized line', async () => {
  const ctx = await setupTest();
  const raw = await subscribeToSocketLines(ctx.socketPath);

  raw.write(`{"v":1,"id":1,"m":"daemon.hello","p":{"pad":"${'x'.repeat(1_100_000)}"}}\n`);

  await raw.closed;

  expect(raw.lines.map((line): unknown => JSON.parse(line))).toStrictEqual([
    { v: 4, id: 0, err: { code: 'bad_args', msg: 'line exceeds 1048576 bytes' } },
  ]);
});

test('it lists no sessions on a fresh daemon', async () => {
  const ctx = await setupTest();
  const list = await ctx.client.sendRequest('session.list');

  expect(list).toStrictEqual({ sessions: [] });
});

test('it answers session.kill for an unknown session with no_such_session', async () => {
  const ctx = await setupTest();

  expect(ctx.client.sendRequest('session.kill', { session: 'nope' })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test('it answers session.ack for an unknown session with no_such_session', async () => {
  const ctx = await setupTest();

  expect(ctx.client.sendRequest('session.ack', { session: 'nope' })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test('it answers session.screen for an unknown session with no_such_session', async () => {
  const ctx = await setupTest();

  expect(ctx.client.sendRequest('session.screen', { session: 'nope' })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test('it answers session.resumeCommand for an unknown session with no_such_session', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.sendRequest('session.resumeCommand', { session: 'nope' }),
  ).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it rejects session.spawn without a cwd as bad_args', async () => {
  const ctx = await setupTest();

  expect(ctx.client.sendRequest('session.spawn', {})).rejects.toMatchObject({ code: 'bad_args' });
});

test('it reports agent claude when session.spawn omits agent', async () => {
  const ctx = await setupTest();
  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, cols: 80, rows: 24 });

  expect(ok['session']).toMatchObject({ agent: 'claude' });
});

test('it answers session.spawn with an unknown parent as no_such_session', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, parent: 'ghost', cols: 80, rows: 24 }),
  ).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it nests a spawn under its parent', async () => {
  const ctx = await setupTest();
  const top = await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, cols: 80, rows: 24 });

  const topID = getRecord(top, 'session')['id'];

  const child = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    parent: topID,
    cols: 80,
    rows: 24,
  });

  expect(child['session']).toMatchObject({ parent: topID });
});

test('it lands a spawn under a sub-session beside that sub-session, under its parent', async () => {
  const ctx = await setupTest();
  const top = await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, cols: 80, rows: 24 });

  const topID = getRecord(top, 'session')['id'];

  const child = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    parent: topID,
    cols: 80,
    rows: 24,
  });

  const grandchild = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    parent: getRecord(child, 'session')['id'],
    cols: 80,
    rows: 24,
  });

  expect(grandchild['session']).toMatchObject({ parent: topID });
});

test('it refuses to pin a sub-session as bad_args', async () => {
  const ctx = await setupTest();
  const top = await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, cols: 80, rows: 24 });

  const child = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    parent: getRecord(top, 'session')['id'],
    cols: 80,
    rows: 24,
  });

  expect(
    ctx.client.sendRequest('session.update', {
      session: getRecord(child, 'session')['id'],
      pinned: true,
    }),
  ).rejects.toMatchObject({ code: 'bad_args' });
});

test('it refuses session.spawn with agent grok as unsupported and records no session', async () => {
  const ctx = await setupTest();

  const spawn = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, agent: 'grok' });

  await Promise.allSettled([spawn]);

  const list = await ctx.client.sendRequest('session.list');
  const fleet = await ctx.client.sendRequest('fleet.list');

  expect(spawn).rejects.toMatchObject({ code: 'unsupported' });
  expect(list).toStrictEqual({ sessions: [] });
  expect(fleet).toStrictEqual({ fleet: [] });
});

test('it spawns a grok session when a grok adapter is registered', async () => {
  const ctx = await startTestDaemon({
    prefix: 'atc-daemon-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter(),
      adapters: [
        new GrokAdapter(
          getAgentEntry(parseConfig({ grokBin: 'bash', grokArgs: ['-c', 'sleep 30'] }), 'grok'),
          join(paths.dir, 'grok-home'),
        ),
      ],
    }),
  });

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  expect(ok['session']).toMatchObject({ agent: 'grok' });
});

test('it yanks a grok session spawned with an id as a resume of that id', async () => {
  const ctx = await startTestDaemon({
    prefix: 'atc-daemon-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter(),
      adapters: [
        new GrokAdapter(
          getAgentEntry(parseConfig({ grokBin: 'bash', grokArgs: ['-c', 'sleep 30'] }), 'grok'),
          join(paths.dir, 'grok-home'),
        ),
      ],
    }),
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'grok',
    resume: 'g-1',
    cols: 80,
    rows: 24,
  });

  const resumed = await ctx.client.sendRequest('session.resumeCommand', {
    session: getRecord(spawned, 'session')['id'],
  });

  expect(resumed).toStrictEqual({ command: `cd '${ctx.dir}' && grok --resume g-1` });
});

test('it yanks a grok session spawned without an id as a plain start', async () => {
  const ctx = await startTestDaemon({
    prefix: 'atc-daemon-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter(),
      adapters: [
        new GrokAdapter(
          getAgentEntry(parseConfig({ grokBin: 'bash', grokArgs: ['-c', 'sleep 30'] }), 'grok'),
          join(paths.dir, 'grok-home'),
        ),
      ],
    }),
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const welcome = await ctx.client.sendRequest('session.resumeCommand', {
    session: getRecord(spawned, 'session')['id'],
  });

  expect(welcome).toStrictEqual({ command: `cd '${ctx.dir}' && grok` });
});

test('it revives a grok session from a captured id when summary.json is missing', async () => {
  const ctx = await startTestDaemon({
    prefix: 'atc-daemon-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter(),
      adapters: [
        new GrokAdapter(
          getAgentEntry(parseConfig({ grokBin: 'bash', grokArgs: ['-c', 'sleep 30'] }), 'grok'),
          join(paths.dir, 'grok-home'),
        ),
      ],
    }),
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'grok',
    resume: 'g-revive',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.kill', { session: id });

  const adopted = await ctx.client.sendRequest('session.adopt', {
    session: id,
    cols: 80,
    rows: 24,
  });

  const listed = await ctx.client.sendRequest('session.list');

  expect(adopted).toStrictEqual({});
  expect(listed).toStrictEqual({ sessions: [expect.objectContaining({ id, alive: true })] });
});

test('it keeps last-used on a spawn that has not reported SessionStart', async () => {
  const ctx = await startTestDaemon({
    prefix: 'atc-daemon-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter(),
      adapters: [
        new GrokAdapter(
          getAgentEntry(parseConfig({ grokBin: 'bash', grokArgs: ['-c', 'sleep 30'] }), 'grok'),
          join(paths.dir, 'grok-home'),
        ),
      ],
    }),
  });

  await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  // The store runs one write at a time in order, and the spawn's last write
  // records its directory, so once that directory lists, every write the
  // spawn made has landed.
  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('dirs.list');

    expect(listed).toStrictEqual({ dirs: [ctx.dir] });
  });

  const probe = await DaemonClient.open(ctx.socketPath);

  registerTestCleanup(() => {
    probe.stop();
  });

  const hello = await probe.sendHello(ctx.build);

  expect(hello).toMatchObject({ lastUsedAgent: 'claude' });
});

test('it spawns claude when a spawn omits agent after another agent was last used', async () => {
  const ctx = await startTestDaemon({
    prefix: 'atc-daemon-',
    options: async (paths) => {
      const store = await StateStore.open(paths.dbPath);

      registerTestCleanup(() => store.stop());

      await store.writeLastUsedAgent('grok');
      await store.stop();

      return {
        adapter: buildMockAgentAdapter(),
        adapters: [
          new GrokAdapter(
            getAgentEntry(parseConfig({ grokBin: 'bash', grokArgs: ['-c', 'sleep 30'] }), 'grok'),
            join(paths.dir, 'grok-home'),
          ),
        ],
      };
    },
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  expect(spawned['session']).toMatchObject({ agent: 'claude' });
});

test('it rejects session.spawn with an unregistered agent id as unsupported', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, agent: 'gemini' }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it rejects session.spawn with an empty agent id as bad_args', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, agent: '' }),
  ).rejects.toMatchObject({ code: 'bad_args' });
});

test('it broadcasts SessionAttached with the session descriptor when a client attaches', async () => {
  const ctx = await setupTest();
  const actor = await ctx.openClient();
  const sessionID = await spawnNamedSession((m, p) => actor.sendRequest(m, p), 'focus-me', ctx.dir);

  await actor.sendRequest('session.attach', { session: sessionID, cols: 80, rows: 24 });

  const event = await waitFor(() => {
    const found = ctx.events.find((e) => e.ev === 'SessionAttached');

    invariant(found !== undefined, 'no SessionAttached yet');

    return found;
  });

  expect(event).toMatchObject({
    v: 4,
    ev: 'SessionAttached',
    session: {
      id: sessionID,
      name: 'focus-me',
      cwd: ctx.dir,
      agent: 'claude',
      kind: 'pty',
      alive: true,
      unread: false,
    },
  });
});

test('it broadcasts SessionDetached when an attached client detaches', async () => {
  const ctx = await setupTest();
  const actor = await ctx.openClient();
  const sessionID = await spawnNamedSession((m, p) => actor.sendRequest(m, p), 'focus-me', ctx.dir);

  await actor.sendRequest('session.attach', { session: sessionID, cols: 80, rows: 24 });
  await actor.sendRequest('session.detach', { session: sessionID });

  const event = await waitFor(() => {
    const found = ctx.events.find((e) => e.ev === 'SessionDetached');

    invariant(found !== undefined, 'no SessionDetached yet');

    return found;
  });

  expect(event).toMatchObject({ v: 4, ev: 'SessionDetached', session: { id: sessionID } });
});

test('it broadcasts SessionDetached when an attached client disconnects', async () => {
  const ctx = await setupTest();
  const actor = await ctx.openClient();
  const sessionID = await spawnNamedSession((m, p) => actor.sendRequest(m, p), 'focus-me', ctx.dir);

  await actor.sendRequest('session.attach', { session: sessionID, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(ctx.events).toPartiallyContain({ ev: 'SessionAttached' });
  });

  actor.stop();

  const event = await waitFor(() => {
    const found = ctx.events.find((e) => e.ev === 'SessionDetached');

    invariant(found !== undefined, 'no SessionDetached yet');

    return found;
  });

  expect(event).toMatchObject({ ev: 'SessionDetached', session: { id: sessionID } });
});

test('it broadcasts no SessionDetached for a detach without an attach', async () => {
  const ctx = await setupTest();
  const actor = await ctx.openClient();
  const sessionID = await spawnNamedSession((m, p) => actor.sendRequest(m, p), 'focus-me', ctx.dir);

  await actor.sendRequest('session.detach', { session: sessionID });
  await actor.sendRequest('session.attach', { session: sessionID, cols: 80, rows: 24 });

  // The attach follows the detach, so its event arriving shows the daemon
  // has already handled the detach.
  await waitFor(() => {
    expect(ctx.events).toPartiallyContain({ ev: 'SessionAttached' });
  });

  expect(ctx.events.filter((e) => e.ev === 'SessionDetached')).toBeEmpty();
});

test('it runs a configured hook with the same event JSON a watching client receives', async () => {
  const ctx = await startTestDaemon({
    prefix: 'atc-daemon-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter(),
      hooks: {
        SessionAttached: [
          {
            command: `cat > '${join(paths.dir, 'hook.out')}'; printf '%s\n' "$ATC_EVENT" >> '${join(paths.dir, 'hook.out')}'`,
          },
        ],
      },
    }),
  });

  const actor = await ctx.openClient();
  const sessionID = await spawnNamedSession((m, p) => actor.sendRequest(m, p), 'focus-me', ctx.dir);

  await actor.sendRequest('session.attach', { session: sessionID, cols: 80, rows: 24 });

  const event = await waitFor(() => {
    const found = ctx.events.find((e) => e.ev === 'SessionAttached');

    invariant(found !== undefined, 'no SessionAttached yet');

    return found;
  });

  const text = await waitFor(() => {
    const written = readFileSync(join(ctx.dir, 'hook.out'), 'utf8');

    invariant(written.endsWith('SessionAttached\n'), 'hook output still incomplete');

    return written;
  });

  const [payload, eventName, rest] = text.split('\n');
  const parsed: unknown = JSON.parse(payload ?? '');

  expect({ payload: parsed, eventName, rest }).toStrictEqual({
    payload: event,
    eventName: 'SessionAttached',
    rest: '',
  });
});

test('it answers session.get for an unknown session with no_such_session', async () => {
  const ctx = await setupTest();

  expect(ctx.client.sendRequest('session.get', { session: 'nope' })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test("it reads a spawned session's prompt through session.get", async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    prompt: 'fix the auth bug',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  const record = await ctx.client.sendRequest('session.get', { session: id });

  expect(record).toStrictEqual({
    session: expect.objectContaining({ id }),
    prompt: 'fix the auth bug',
    lastActivityAt: expect.toBeNumber(),
    pending: null,
    result: null,
  });
});

test('it answers session.read for an unknown session with no_such_session', async () => {
  const ctx = await setupTest();

  expect(ctx.client.sendRequest('session.read', { session: 'nope' })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test('it answers session.read with unsupported for an agent atc cannot read the transcript of', async () => {
  const ctx = await setupTest();
  const id = await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'worker', ctx.dir);

  expect(ctx.client.sendRequest('session.read', { session: id })).rejects.toMatchObject({
    code: 'unsupported',
  });
});

test('it rejects a session.read cursor the daemon never issued with bad_args', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.sendRequest('session.read', { session: 'nope', cursor: 'garbage' }),
  ).rejects.toMatchObject({ code: 'bad_args' });
});

test('it rejects an events cursor passed to session.read with bad_args', async () => {
  const ctx = await setupTest();
  const events = await ctx.client.sendRequest('events.read', {});

  expect(
    ctx.client.sendRequest('session.read', { session: 'nope', cursor: events['cursor'] }),
  ).rejects.toMatchObject({ code: 'bad_args' });
});

test('it rejects a transcript cursor passed to events.read with bad_args', async () => {
  const ctx = await setupTest();

  const cursor = encodeCursor({ kind: 'transcript', path: join(ctx.dir, 'x'), offset: 0 });

  expect(ctx.client.sendRequest('events.read', { cursor })).rejects.toMatchObject({
    code: 'bad_args',
  });
});

test('it answers events.read on an empty trail at once with no events and a cursor', async () => {
  const ctx = await setupTest();
  const answer = await ctx.client.sendRequest('events.read', {});

  expect(answer).toStrictEqual({ events: [], cursor: expect.any(String), more: false });
});

test('it holds events.read open while no event arrives within waitMs', async () => {
  const ctx = await setupTest();

  const read = ctx.client.sendRequest('events.read', { waitMs: 600_000 });

  // The read fails when disposal closes the client; settling it here keeps
  // that failure from going unhandled.
  void Promise.allSettled([read]);

  // The ping goes out after the read on the same connection, so its answer
  // shows the daemon has taken the read and is holding it.
  await ctx.client.sendRequest('daemon.ping');

  expect(Bun.peek.status(read)).toBe('pending');
});

test('it answers events.read with no events once waitMs passes without one', async () => {
  const clock = buildStubClock(0);

  const ctx = await startTestDaemon({
    prefix: 'atc-daemon-',
    options: () => ({ adapter: buildMockAgentAdapter(), clock }),
  });

  const read = ctx.client.sendRequest('events.read', { waitMs: 30_000 });

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([30_000]);
  });

  clock.advance(30_000);

  const answer = await read;

  expect(answer).toStrictEqual({ events: [], cursor: expect.any(String), more: false });
});

test('it answers daemon.hello with the same daemon id after a restart', async () => {
  const ctx = await setupTest();
  const firstHello = await ctx.client.sendHello(ctx.build);

  await ctx.restart();

  const second = await DaemonClient.open(ctx.socketPath);

  registerTestCleanup(() => {
    second.stop();
  });

  const secondHello = await second.sendHello(ctx.build);

  expect(secondHello['daemonID']).toBe(firstHello['daemonID']);
});

test('it locates a spawned session on this daemon at the local target', async () => {
  const ctx = await setupTest();
  const probe = await DaemonClient.open(ctx.socketPath);

  registerTestCleanup(() => {
    probe.stop();
  });

  const hello = await probe.sendHello(ctx.build);
  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, cols: 80, rows: 24 });

  expect(ok['session']).toMatchObject({
    locator: { daemonID: hello['daemonID'], targetID: 'local' },
  });
});

test('it answers a kill whose fleet write meets a moved ownership epoch with stale_epoch', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const sessionID = getRecord(spawned, 'session')['id'];

  const db = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    db.close();
  });

  await waitFor(() => {
    expect(
      db.query('SELECT session_id FROM session_owner WHERE session_id = ?1').all(String(sessionID)),
    ).toHaveLength(1);
  });

  db.run('UPDATE session_owner SET owner_epoch = 2 WHERE session_id = ?1', [String(sessionID)]);

  expect(ctx.client.sendRequest('session.kill', { session: sessionID })).rejects.toMatchObject({
    code: 'stale_epoch',
  });
});

test('it stops the daemon when its handle is disposed', async () => {
  const ctx = await setupTest();

  await ctx.daemon[Symbol.asyncDispose]();

  expect(existsSync(join(ctx.dir, 'daemon.json'))).toBeFalse();
});

test('it releases nothing again when a stopped handle is disposed', async () => {
  const ctx = await setupTest();

  const stopped = ctx.daemon;

  await ctx.restart();

  const disposed = stopped[Symbol.asyncDispose]();

  await expect(disposed).toResolve();

  expect(existsSync(join(ctx.dir, 'daemon.json'))).toBeTrue();
});
