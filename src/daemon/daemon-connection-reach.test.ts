import { expect, mock, test } from 'bun:test';
import { PROTOCOL_V } from '../protocol/protocol';
import { toDaemonID } from '../shared/to-daemon-id';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import { buildStubDaemonContext } from '../test-utils/build-stub-daemon-context';
import { buildStubPeerSocket } from '../test-utils/build-stub-peer-socket';
import { waitFor } from '../test-utils/wait-for';
import { DaemonConnection } from './daemon-connection';
import type { DaemonContext } from './daemon-context';

interface ReachTestConfig {
  // The daemon members the test drives, over the stub daemon's defaults.
  readonly daemon: Partial<DaemonContext>;
}

/**
 * A connection over a stub daemon with the given members. `request` sends
 * one request and resolves with its answer frame, the request's own id left
 * out, so two answers compare whole.
 */
function setupTest(config: ReachTestConfig) {
  const peer = buildStubPeerSocket();

  const conn = new DaemonConnection(peer.socket, buildStubDaemonContext(config.daemon));

  let nextID = 2;

  // Every test reads as a principal, the caller whose reach the daemon
  // checks on each answer.
  conn.applyChunk(
    `${JSON.stringify({ v: PROTOCOL_V, id: 1, m: 'daemon.hello', p: { client: 'atc/test', principal: 'narrow' } })}\n`,
  );

  return {
    request: (m: string, p: Readonly<Record<string, unknown>>) => {
      const id = nextID;

      nextID += 1;

      conn.applyChunk(`${JSON.stringify({ v: PROTOCOL_V, id, m, p })}\n`);

      return waitFor(() => {
        const frame = peer.collectFrames().find((candidate) => candidate['id'] === id);

        expect(frame).toBeObject();

        return Object.fromEntries(Object.entries({ ...frame }).filter(([key]) => key !== 'id'));
      });
    },
  };
}

test('it answers session.get whose session leaves the view during the read as for a session that does not exist', async () => {
  const entered = Promise.withResolvers<void>();
  const record = Promise.withResolvers<Awaited<ReturnType<DaemonContext['readSessionRecord']>>>();
  const canSeeSession = mock<DaemonContext['canSeeSession']>(() => true);

  const readSessionRecord = mock<DaemonContext['readSessionRecord']>(() => {
    entered.resolve();

    return record.promise;
  });

  readSessionRecord.mockImplementationOnce(() => Promise.resolve('missing'));

  const ctx = setupTest({ daemon: { canSeeSession, readSessionRecord } });

  const missing = await ctx.request('session.get', { session: 's-held' });

  const held = ctx.request('session.get', { session: 's-held' });

  await entered.promise;

  canSeeSession.mockReturnValue(false);

  record.resolve({
    session: {
      id: toSessionID('s-held'),
      name: 'secret',
      cwd: '/srv/secret',
      state: 'running',
      unread: false,
      lastMsg: 'secret',
      agent: 'claude',
      pinned: false,
      lastAttachedAt: 0,
      repoRoot: '/srv/secret',
      namedBy: 'auto',
      createdAt: 0,
      kind: 'pty',
      alive: true,
      canEject: false,
      locator: { daemonID: toDaemonID('d-1'), targetID: 'local' },
      lifecycle: { desired: 'run', vm: 'none', harness: 'running', attachment: 'local' },
    },
    prompt: 'secret',
    lastActivityAt: 0,
    pending: null,
    result: null,
  });

  const answered = await held;

  expect(answered).toStrictEqual(missing);
  expect(answered).toMatchObject({ err: { code: 'no_such_session' } });
});

test('it answers session.screen whose session leaves the view during the read as for a session that does not exist', async () => {
  const entered = Promise.withResolvers<void>();
  const screen = Promise.withResolvers<Awaited<ReturnType<DaemonContext['readSessionScreen']>>>();
  const canSeeSession = mock<DaemonContext['canSeeSession']>(() => true);

  const readSessionScreen = mock<DaemonContext['readSessionScreen']>(() => {
    entered.resolve();

    return screen.promise;
  });

  readSessionScreen.mockImplementationOnce(() => Promise.resolve('missing'));

  const ctx = setupTest({ daemon: { canSeeSession, readSessionScreen } });

  const missing = await ctx.request('session.screen', { session: 's-held' });

  const held = ctx.request('session.screen', { session: 's-held' });

  await entered.promise;

  canSeeSession.mockReturnValue(false);
  screen.resolve({ text: 'secret', cols: 80, rows: 24 });

  const answered = await held;

  expect(answered).toStrictEqual(missing);
  expect(answered).toMatchObject({ err: { code: 'no_such_session' } });
});

test('it answers session.read whose session leaves the view during the read as for a session that does not exist', async () => {
  const entered = Promise.withResolvers<void>();

  const transcript =
    Promise.withResolvers<Awaited<ReturnType<DaemonContext['loadSessionTranscript']>>>();

  const canSeeSession = mock<DaemonContext['canSeeSession']>(() => true);

  const loadSessionTranscript = mock<DaemonContext['loadSessionTranscript']>(() => {
    entered.resolve();

    return transcript.promise;
  });

  loadSessionTranscript.mockImplementationOnce(() => Promise.resolve('missing'));

  const ctx = setupTest({ daemon: { canSeeSession, loadSessionTranscript } });

  const missing = await ctx.request('session.read', { session: 's-held' });

  const held = ctx.request('session.read', { session: 's-held' });

  await entered.promise;

  canSeeSession.mockReturnValue(false);

  transcript.resolve({
    path: '/srv/secret/transcript.jsonl',
    page: { rows: [], offset: 0, more: false },
  });

  const answered = await held;

  expect(answered).toStrictEqual(missing);
  expect(answered).toMatchObject({ err: { code: 'no_such_session' } });
});

test('it leaves out of events.read the events of a session that leaves the view during the read', async () => {
  const entered = Promise.withResolvers<void>();
  const events = Promise.withResolvers<Awaited<ReturnType<DaemonContext['readEvents']>>>();
  const canSeeSession = mock<DaemonContext['canSeeSession']>(() => true);

  const readEvents = mock<DaemonContext['readEvents']>(() => {
    entered.resolve();

    return events.promise;
  });

  readEvents.mockImplementationOnce(() => Promise.resolve({ events: [], more: false }));

  const ctx = setupTest({ daemon: { canSeeSession, readEvents } });

  const empty = await ctx.request('events.read', { session: 's-held', waitMs: 0 });

  const held = ctx.request('events.read', { session: 's-held', waitMs: 0 });

  await entered.promise;

  canSeeSession.mockReturnValue(false);

  events.resolve({
    events: [
      {
        cursor: 'c-1',
        at: 0,
        session: 's-held',
        name: 'secret',
        kind: 'message-accepted',
        detail: 'secret',
      },
    ],
    more: false,
  });

  const answered = await held;

  expect(answered).toStrictEqual(empty);
  expect(answered).toMatchObject({ ok: { events: [], more: false } });
});

test('it answers report.get whose session leaves the view during the read as for a report that does not exist', async () => {
  const entered = Promise.withResolvers<void>();
  const report = Promise.withResolvers<Awaited<ReturnType<DaemonContext['readReport']>>>();
  const canSeeSession = mock<DaemonContext['canSeeSession']>(() => true);

  const readReport = mock<DaemonContext['readReport']>(() => {
    entered.resolve();

    return report.promise;
  });

  readReport.mockImplementationOnce(() => Promise.resolve(null));

  const ctx = setupTest({ daemon: { canSeeSession, readReport } });

  const missing = await ctx.request('report.get', { report: 'eyJrIjoiZXYiLCJpIjoxfQ' });

  const held = ctx.request('report.get', { report: 'eyJrIjoiZXYiLCJpIjoxfQ' });

  await entered.promise;

  canSeeSession.mockReturnValue(false);

  report.resolve({
    owner: toSessionID('s-held'),
    view: {
      report: 'eyJrIjoiZXYiLCJpIjoxfQ',
      at: 0,
      session: 's-held',
      name: 'secret',
      label: 'l',
      text: 'secret',
      complete: true,
    },
  });

  const answered = await held;

  expect(answered).toStrictEqual(missing);
  expect(answered).toMatchObject({ err: { code: 'bad_args' } });
});

test('it answers report.get whose sender leaves the view during the read as for a report that does not exist, whatever session its view is named by', async () => {
  const entered = Promise.withResolvers<void>();
  const report = Promise.withResolvers<Awaited<ReturnType<DaemonContext['readReport']>>>();
  const canSeeSession = mock<DaemonContext['canSeeSession']>(() => true);

  const readReport = mock<DaemonContext['readReport']>(() => {
    entered.resolve();

    return report.promise;
  });

  readReport.mockImplementationOnce(() => Promise.resolve(null));

  const ctx = setupTest({ daemon: { canSeeSession, readReport } });

  const missing = await ctx.request('report.get', { report: 'eyJrIjoiZXYiLCJpIjoxfQ' });

  const held = ctx.request('report.get', { report: 'eyJrIjoiZXYiLCJpIjoxfQ' });

  await entered.promise;

  canSeeSession.mockImplementation((id) => id !== 's-held');

  report.resolve({
    owner: toSessionID('s-held'),
    view: {
      report: 'eyJrIjoiZXYiLCJpIjoxfQ',
      at: 0,
      session: 's-shown',
      name: 'shown',
      label: 'l',
      text: 'secret',
      complete: true,
    },
  });

  const answered = await held;

  expect(answered).toStrictEqual(missing);
});

test('it answers message.get whose session leaves the view during the wait as for an unknown message', async () => {
  const entered = Promise.withResolvers<void>();
  const message = Promise.withResolvers<Awaited<ReturnType<DaemonContext['readMessage']>>>();
  const canSeeSession = mock<DaemonContext['canSeeSession']>(() => true);

  const readMessage = mock<DaemonContext['readMessage']>(() => {
    entered.resolve();

    return message.promise;
  });

  readMessage.mockImplementationOnce(() => Promise.resolve(null));

  const ctx = setupTest({ daemon: { canSeeSession, readMessage } });

  const unknown = await ctx.request('message.get', { message: 'm-held', waitMs: 0 });

  const held = ctx.request('message.get', { message: 'm-held', waitMs: 30_000 });

  await entered.promise;

  canSeeSession.mockReturnValue(false);

  message.resolve({
    session: toSessionID('s-held'),
    record: {
      id: toMessageID('m-held'),
      atcID: toSessionID('s-held'),
      from: 'owner',
      text: 'secret',
      status: 'delivered',
      sentAt: 0,
    },
    answeredWith: [],
  });

  const answered = await held;

  expect(answered).toStrictEqual(unknown);
  expect(answered).toMatchObject({ err: { code: 'bad_args' } });
});

test('it answers message.ack whose session leaves the view during the ack as for an unknown message', async () => {
  const entered = Promise.withResolvers<void>();
  const ack = Promise.withResolvers<Awaited<ReturnType<DaemonContext['ackMessage']>>>();
  const canSeeSession = mock<DaemonContext['canSeeSession']>(() => true);

  const ackMessage = mock<DaemonContext['ackMessage']>(() => {
    entered.resolve();

    return ack.promise;
  });

  ackMessage.mockImplementationOnce(() => Promise.resolve('unknown'));

  const ctx = setupTest({ daemon: { canSeeSession, ackMessage } });

  const unknown = await ctx.request('message.ack', { session: 's-held', message: 'm-held' });

  const held = ctx.request('message.ack', { session: 's-held', message: 'm-held' });

  await entered.promise;

  canSeeSession.mockReturnValue(false);

  ack.resolve({
    id: toMessageID('m-held'),
    atcID: toSessionID('s-held'),
    from: 'owner',
    text: 'secret',
    status: 'delivered',
    sentAt: 0,
  });

  const answered = await held;

  expect(answered).toStrictEqual(unknown);
  expect(answered).toMatchObject({ err: { code: 'bad_args' } });
});

test('it answers session.message whose session leaves the view during the write as for a session that does not exist', async () => {
  const entered = Promise.withResolvers<void>();
  const write = Promise.withResolvers<Awaited<ReturnType<DaemonContext['writeSessionMessage']>>>();
  const canSeeSession = mock<DaemonContext['canSeeSession']>(() => true);

  const writeSessionMessage = mock<DaemonContext['writeSessionMessage']>(() => {
    entered.resolve();

    return write.promise;
  });

  writeSessionMessage.mockImplementationOnce(() => Promise.resolve('missing'));

  const ctx = setupTest({ daemon: { canSeeSession, writeSessionMessage } });

  const missing = await ctx.request('session.message', {
    session: 's-held',
    from: 'remote',
    text: 'hello',
  });

  const held = ctx.request('session.message', { session: 's-held', from: 'remote', text: 'hello' });

  await entered.promise;

  canSeeSession.mockReturnValue(false);
  write.resolve({ message: 'm-1', status: 'accepted' });

  const answered = await held;

  expect(answered).toStrictEqual(missing);
  expect(answered).toMatchObject({ err: { code: 'no_such_session' } });
});

test('it refuses a spawn whose session leaves the view before the answer as a replay out of reach is refused', async () => {
  const entered = Promise.withResolvers<void>();
  const spawn = Promise.withResolvers<Awaited<ReturnType<DaemonContext['spawnSession']>>>();
  const canSeeSession = mock<DaemonContext['canSeeSession']>(() => true);

  const ctx = setupTest({
    daemon: {
      canSeeSession,
      spawnSession: () => {
        entered.resolve();

        return spawn.promise;
      },
    },
  });

  const held = ctx.request('session.spawn', { cwd: '/srv/project' });

  await entered.promise;

  canSeeSession.mockReturnValue(false);

  spawn.resolve({
    session: { id: 's-new', name: 'secret', locator: { daemonID: 'd-1', targetID: 'local' } },
  });

  const answered = await held;

  expect(answered).toStrictEqual({
    v: PROTOCOL_V,
    err: {
      code: 'target_forbidden',
      msg: "this client may not use execution target 'local'. Grant it to the client under principals in config.json and restart the daemon",
      data: { target: 'local' },
    },
  });
});

test('it leaves out of fleet.list a session that leaves the view during the read', async () => {
  const entered = Promise.withResolvers<void>();
  const fleet = Promise.withResolvers<Awaited<ReturnType<DaemonContext['collectFleet']>>>();
  const canSeeSession = mock<DaemonContext['canSeeSession']>(() => true);

  const collectFleet = mock<DaemonContext['collectFleet']>(() => {
    entered.resolve();

    return fleet.promise;
  });

  collectFleet.mockImplementationOnce(() => Promise.resolve([]));

  const ctx = setupTest({ daemon: { canSeeSession, collectFleet } });

  const empty = await ctx.request('fleet.list', {});

  const held = ctx.request('fleet.list', {});

  await entered.promise;

  canSeeSession.mockReturnValue(false);

  fleet.resolve([
    { sessionID: toSessionID('s-held'), name: 'secret', cwd: '/srv/secret', agent: 'claude' },
  ]);

  const answered = await held;

  expect(answered).toStrictEqual(empty);
  expect(answered).toMatchObject({ ok: { fleet: [] } });
});
