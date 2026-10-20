import { Database } from 'bun:sqlite';
import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { GrokAdapter } from '@atc/harness-grok';
import { encodeCursor } from '@atc/protocol';
import { openDaemonClient } from '@atc/protocol/client';
import { StateStore } from '@atc/store';
import {
  buildMockAgentAdapter,
  buildStubClock,
  getAgentEntry,
  getRecord,
  registerTestCleanup,
  spawnNamedSession,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

function setupTest() {
  return startTestDaemon({
    prefix: 'atc-daemon-',

    // Every spawn needs a Claude adapter; this one runs a sleep.
    options: () => ({ adapter: buildMockAgentAdapter() }),
  });
}

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

test('it answers daemon.ping after the handshake', async () => {
  const ctx = await setupTest();
  const pong = await ctx.client.sendRequest('daemon.ping');

  expect(pong).toStrictEqual({});
});

test('it answers an unknown method with unknown_method', async () => {
  const ctx = await setupTest();

  expect(ctx.client.sendRequest('session.levitate')).rejects.toMatchObject({
    code: 'unknown_method',
  });
});

test('it stays connected after answering an unknown method', async () => {
  const ctx = await setupTest();

  const refused = ctx.client.sendRequest('session.levitate');

  await Promise.allSettled([refused]);

  const pong = await ctx.client.sendRequest('daemon.ping');

  expect(refused).rejects.toMatchObject({ code: 'unknown_method' });
  expect(pong).toStrictEqual({});
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

test('it stops a live session and its sub-sessions on a stop-only kill', async () => {
  const ctx = await setupTest();

  const parent = await spawnNamedSession(
    (method, params) => ctx.client.sendRequest(method, params),
    'one',
    ctx.directory,
  );

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    parent,
    cols: 80,
    rows: 24,
  });

  const child = getRecord(spawned, 'session')['id'];

  const answer = await ctx.client.sendRequest('session.kill', { session: parent, stopOnly: true });
  const listed = await ctx.client.sendRequest('session.list');

  expect(answer).toStrictEqual({ stopped: true });

  expect(listed).toStrictEqual({
    sessions: [
      expect.objectContaining({ id: parent, alive: false }),
      expect.objectContaining({ id: child, alive: false }),
    ],
  });
});

test('it leaves an exited session in the list on a stop-only kill', async () => {
  const ctx = await setupTest();

  const id = await spawnNamedSession(
    (method, params) => ctx.client.sendRequest(method, params),
    'one',
    ctx.directory,
  );

  await ctx.client.sendRequest('session.kill', { session: id, stopOnly: true });

  const again = await ctx.client.sendRequest('session.kill', { session: id, stopOnly: true });
  const listed = await ctx.client.sendRequest('session.list');

  expect(again).toStrictEqual({ stopped: false });
  expect(listed).toStrictEqual({ sessions: [expect.objectContaining({ id, alive: false })] });
});

test('it removes an exited session on a second kill without stopOnly', async () => {
  const ctx = await setupTest();

  const id = await spawnNamedSession(
    (method, params) => ctx.client.sendRequest(method, params),
    'one',
    ctx.directory,
  );

  const first = await ctx.client.sendRequest('session.kill', { session: id });
  const second = await ctx.client.sendRequest('session.kill', { session: id });
  const listed = await ctx.client.sendRequest('session.list');

  expect(first).toStrictEqual({});
  expect(second).toStrictEqual({});
  expect(listed).toStrictEqual({ sessions: [] });
});

test('it answers a stop-only kill of an unknown session with no_such_session', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.sendRequest('session.kill', { session: 'nope', stopOnly: true }),
  ).rejects.toMatchObject({ code: 'no_such_session' });
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

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  expect(ok['session']).toMatchObject({ agent: 'claude' });
});

test('it answers session.spawn with an unknown parent as no_such_session', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.sendRequest('session.spawn', {
      cwd: ctx.directory,
      parent: 'ghost',
      cols: 80,
      rows: 24,
    }),
  ).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it nests a spawn under its parent', async () => {
  const ctx = await setupTest();

  const top = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const topID = getRecord(top, 'session')['id'];

  const child = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    parent: topID,
    cols: 80,
    rows: 24,
  });

  expect(child['session']).toMatchObject({ parent: topID });
});

test('it lands a spawn under a sub-session beside that sub-session, under its parent', async () => {
  const ctx = await setupTest();

  const top = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const topID = getRecord(top, 'session')['id'];

  const child = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    parent: topID,
    cols: 80,
    rows: 24,
  });

  const grandchild = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    parent: getRecord(child, 'session')['id'],
    cols: 80,
    rows: 24,
  });

  expect(grandchild['session']).toMatchObject({ parent: topID });
});

test('it pins a sub-session on its own', async () => {
  const ctx = await setupTest();

  const top = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const child = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    parent: getRecord(top, 'session')['id'],
    cols: 80,
    rows: 24,
  });

  const childID = getRecord(child, 'session')['id'];

  await ctx.client.sendRequest('session.update', { session: childID, pinned: true });

  expect(ctx.client.sendRequest('session.get', { session: childID })).resolves.toMatchObject({
    session: { id: childID, pinned: true },
  });
});

test('it refuses session.spawn with agent grok as unsupported and records no session', async () => {
  const ctx = await setupTest();

  const spawn = ctx.client.sendRequest('session.spawn', { cwd: ctx.directory, agent: 'grok' });

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
          getAgentEntry(
            parseConfig(SHIPPED_HARNESS_PLUGINS, {
              agents: { grok: { kind: 'grok', bin: 'bash', args: ['-c', 'sleep 30'] } },
            }),
            'grok',
          ),
          join(paths.directory, 'grok-home'),
        ),
      ],
    }),
  });

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
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
          getAgentEntry(
            parseConfig(SHIPPED_HARNESS_PLUGINS, {
              agents: { grok: { kind: 'grok', bin: 'bash', args: ['-c', 'sleep 30'] } },
            }),
            'grok',
          ),
          join(paths.directory, 'grok-home'),
        ),
      ],
    }),
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    agent: 'grok',
    resume: 'g-1',
    cols: 80,
    rows: 24,
  });

  const resumed = await ctx.client.sendRequest('session.resumeCommand', {
    session: getRecord(spawned, 'session')['id'],
  });

  expect(resumed).toStrictEqual({ command: `cd '${ctx.directory}' && grok --resume g-1` });
});

test('it yanks a grok session spawned without an id as a plain start', async () => {
  const ctx = await startTestDaemon({
    prefix: 'atc-daemon-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter(),
      adapters: [
        new GrokAdapter(
          getAgentEntry(
            parseConfig(SHIPPED_HARNESS_PLUGINS, {
              agents: { grok: { kind: 'grok', bin: 'bash', args: ['-c', 'sleep 30'] } },
            }),
            'grok',
          ),
          join(paths.directory, 'grok-home'),
        ),
      ],
    }),
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const welcome = await ctx.client.sendRequest('session.resumeCommand', {
    session: getRecord(spawned, 'session')['id'],
  });

  expect(welcome).toStrictEqual({ command: `cd '${ctx.directory}' && grok` });
});

test('it revives a grok session from a captured id when summary.json is missing', async () => {
  const ctx = await startTestDaemon({
    prefix: 'atc-daemon-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter(),
      adapters: [
        new GrokAdapter(
          getAgentEntry(
            parseConfig(SHIPPED_HARNESS_PLUGINS, {
              agents: { grok: { kind: 'grok', bin: 'bash', args: ['-c', 'sleep 30'] } },
            }),
            'grok',
          ),
          join(paths.directory, 'grok-home'),
        ),
      ],
    }),
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    agent: 'grok',
    resume: 'g-revive',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.kill', { session: id });

  const killed = await ctx.client.sendRequest('session.list');

  const adopted = await ctx.client.sendRequest('session.adopt', {
    session: id,
    cols: 80,
    rows: 24,
  });

  const listed = await ctx.client.sendRequest('session.list');

  expect(killed).toStrictEqual({ sessions: [expect.objectContaining({ id, alive: false })] });
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
          getAgentEntry(
            parseConfig(SHIPPED_HARNESS_PLUGINS, {
              agents: { grok: { kind: 'grok', bin: 'bash', args: ['-c', 'sleep 30'] } },
            }),
            'grok',
          ),
          join(paths.directory, 'grok-home'),
        ),
      ],
    }),
  });

  await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  // The store runs one write at a time in order, and the spawn's last write
  // records its directory, so once that directory lists, every write the
  // spawn made has landed.
  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('dirs.list');

    expect(listed).toStrictEqual({ dirs: [ctx.directory] });
  });

  const probe = await openDaemonClient(ctx.socketPath);

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
            getAgentEntry(
              parseConfig(SHIPPED_HARNESS_PLUGINS, {
                agents: { grok: { kind: 'grok', bin: 'bash', args: ['-c', 'sleep 30'] } },
              }),
              'grok',
            ),
            join(paths.directory, 'grok-home'),
          ),
        ],
      };
    },
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  expect(spawned['session']).toMatchObject({ agent: 'claude' });
});

test('it rejects session.spawn with an unregistered agent id as unsupported', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.sendRequest('session.spawn', { cwd: ctx.directory, agent: 'gemini' }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it rejects session.spawn with an empty agent id as bad_args', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.sendRequest('session.spawn', { cwd: ctx.directory, agent: '' }),
  ).rejects.toMatchObject({ code: 'bad_args' });
});

test('it broadcasts SessionAttached with the session descriptor when a client attaches', async () => {
  const ctx = await setupTest();
  const actor = await ctx.openClient();

  const sessionID = await spawnNamedSession(
    (method, params) => actor.sendRequest(method, params),
    'focus-me',
    ctx.directory,
  );

  await actor.sendRequest('session.attach', { session: sessionID, cols: 80, rows: 24 });

  const event = await waitFor(() => {
    const found = ctx.events.find((daemonEvent) => daemonEvent.ev === 'SessionAttached');

    invariant(found !== undefined, 'no SessionAttached yet');

    return found;
  });

  expect(event).toMatchObject({
    ev: 'SessionAttached',
    session: {
      id: sessionID,
      name: 'focus-me',
      cwd: ctx.directory,
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

  const sessionID = await spawnNamedSession(
    (method, params) => actor.sendRequest(method, params),
    'focus-me',
    ctx.directory,
  );

  await actor.sendRequest('session.attach', { session: sessionID, cols: 80, rows: 24 });
  await actor.sendRequest('session.detach', { session: sessionID });

  const event = await waitFor(() => {
    const found = ctx.events.find((daemonEvent) => daemonEvent.ev === 'SessionDetached');

    invariant(found !== undefined, 'no SessionDetached yet');

    return found;
  });

  expect(event).toMatchObject({ ev: 'SessionDetached', session: { id: sessionID } });
});

test('it broadcasts SessionDetached when an attached client disconnects', async () => {
  const ctx = await setupTest();
  const actor = await ctx.openClient();

  const sessionID = await spawnNamedSession(
    (method, params) => actor.sendRequest(method, params),
    'focus-me',
    ctx.directory,
  );

  await actor.sendRequest('session.attach', { session: sessionID, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(ctx.events).toPartiallyContain({ ev: 'SessionAttached' });
  });

  actor.stop();

  const event = await waitFor(() => {
    const found = ctx.events.find((daemonEvent) => daemonEvent.ev === 'SessionDetached');

    invariant(found !== undefined, 'no SessionDetached yet');

    return found;
  });

  expect(event).toMatchObject({ ev: 'SessionDetached', session: { id: sessionID } });
});

test('it broadcasts no SessionDetached for a detach without an attach', async () => {
  const ctx = await setupTest();
  const actor = await ctx.openClient();

  const sessionID = await spawnNamedSession(
    (method, params) => actor.sendRequest(method, params),
    'focus-me',
    ctx.directory,
  );

  await actor.sendRequest('session.detach', { session: sessionID });
  await actor.sendRequest('session.attach', { session: sessionID, cols: 80, rows: 24 });

  // The attach follows the detach, so its event arriving shows the daemon
  // has already handled the detach.
  await waitFor(() => {
    expect(ctx.events).toPartiallyContain({ ev: 'SessionAttached' });
  });

  expect(ctx.events.filter((daemonEvent) => daemonEvent.ev === 'SessionDetached')).toBeEmpty();
});

test('it runs a configured hook with the same event JSON a watching client receives', async () => {
  const ctx = await startTestDaemon({
    prefix: 'atc-daemon-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter(),
      hooks: {
        SessionAttached: [
          {
            command: `cat > '${join(paths.directory, 'hook.out')}'; printf '%s\n' "$ATC_EVENT" >> '${join(paths.directory, 'hook.out')}'`,
          },
        ],
      },
    }),
  });

  const actor = await ctx.openClient();

  const sessionID = await spawnNamedSession(
    (method, params) => actor.sendRequest(method, params),
    'focus-me',
    ctx.directory,
  );

  await actor.sendRequest('session.attach', { session: sessionID, cols: 80, rows: 24 });

  const event = await waitFor(() => {
    const found = ctx.events.find((daemonEvent) => daemonEvent.ev === 'SessionAttached');

    invariant(found !== undefined, 'no SessionAttached yet');

    return found;
  });

  const text = await waitFor(() => {
    const written = readFileSync(join(ctx.directory, 'hook.out'), 'utf8');

    invariant(written.endsWith('SessionAttached\n'), 'hook output still incomplete');

    return written;
  });

  const [payload, eventName, rest] = text.split('\n');
  const parsed: unknown = JSON.parse(payload ?? '');

  // The hook reads the wire form, which carries the protocol version the
  // client drops.
  expect({ payload: parsed, eventName, rest }).toStrictEqual({
    payload: { v: 6, ...event },
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
    cwd: ctx.directory,
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
    sessionRecord: expect.objectContaining({
      format: 'atc.session-record',
      session: id,
      revision: 1,
    }),
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

  const id = await spawnNamedSession(
    (method, params) => ctx.client.sendRequest(method, params),
    'worker',
    ctx.directory,
  );

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

  const cursor = encodeCursor({ kind: 'transcript', path: join(ctx.directory, 'x'), offset: 0 });

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

  // The read fails when cleanup closes the client; settling it here keeps
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

test('it stops only once the quit delay has passed after it answers daemon.quit', async () => {
  const clock = buildStubClock(0);
  const onQuit = mock(() => {});

  const ctx = await startTestDaemon({
    prefix: 'atc-daemon-',
    options: () => ({ adapter: buildMockAgentAdapter(), clock, onQuit }),
  });

  const answer = await ctx.client.sendRequest('daemon.quit');

  const pending = clock.collectPending();
  const quitsBeforeDelay = onQuit.mock.calls.length;

  clock.advance(80);

  await waitFor(() => {
    expect(onQuit).toHaveBeenCalledOnce();
  });

  expect(answer).toStrictEqual({});
  expect(pending).toStrictEqual([80]);
  expect(quitsBeforeDelay).toBe(0);
});

test('it answers daemon.hello with the same daemon id after a restart', async () => {
  const ctx = await setupTest();
  const first = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    first.stop();
  });

  const firstHello = await first.sendHello(ctx.build);

  await ctx.restart();

  const second = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    second.stop();
  });

  const secondHello = await second.sendHello(ctx.build);

  expect(secondHello['daemonID']).toBe(firstHello['daemonID']);
});

test('it locates a spawned session on this daemon at the local target', async () => {
  const ctx = await setupTest();
  const probe = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    probe.stop();
  });

  const hello = await probe.sendHello(ctx.build);

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  expect(ok['session']).toMatchObject({
    locator: { daemonID: hello['daemonID'], targetID: 'local' },
  });
});

test('it answers a kill whose fleet write meets a moved ownership epoch with stale_epoch', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
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
