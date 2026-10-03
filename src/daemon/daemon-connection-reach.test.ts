import { expect, test } from 'bun:test';
import { waitFor } from '../../test/wait-for';
import { PROTOCOL_V } from '../protocol/protocol';
import { toDaemonID } from '../shared/to-daemon-id';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import { DaemonConnection } from './daemon-connection';
import type { DaemonContext } from './daemon-context';
import { TargetAccess } from './target-access';

function assertUnreachable(): never {
  throw new Error('unreachable in this test');
}

/**
 * A connection that acts as a principal over a daemon whose reads of
 * session `s-held`, trail id 1, and message `m-held` each wait on a
 * deferred the test settles, and miss for every other id; its fleet
 * read waits on a deferred too while `setFleetHeld(true)` is in force. The principal
 * sees every session while `visible` is true and none once it is false.
 * `entered` settles when a held read starts. `request` sends one request
 * and resolves with its answer frame, the request's own id left out.
 */
function setupTest() {
  let visible = true;

  const hidden = new Set<string>();

  let written = '';
  let nextID = 2;
  const entered = Promise.withResolvers<void>();

  const holds = {
    record: Promise.withResolvers<Awaited<ReturnType<DaemonContext['readSessionRecord']>>>(),
    screen: Promise.withResolvers<Awaited<ReturnType<DaemonContext['readSessionScreen']>>>(),
    transcript:
      Promise.withResolvers<Awaited<ReturnType<DaemonContext['loadSessionTranscript']>>>(),
    events: Promise.withResolvers<Awaited<ReturnType<DaemonContext['readEvents']>>>(),
    report: Promise.withResolvers<Awaited<ReturnType<DaemonContext['readReport']>>>(),
    message: Promise.withResolvers<Awaited<ReturnType<DaemonContext['readMessage']>>>(),
    write: Promise.withResolvers<Awaited<ReturnType<DaemonContext['writeSessionMessage']>>>(),
    spawn: Promise.withResolvers<Awaited<ReturnType<DaemonContext['spawnSession']>>>(),
    ack: Promise.withResolvers<Awaited<ReturnType<DaemonContext['ackMessage']>>>(),
    fleet: Promise.withResolvers<Awaited<ReturnType<DaemonContext['collectFleet']>>>(),
  };

  let isFleetHeld = false;

  // oxlint-disable-next-line prefer-readonly-parameter-types -- a promise has no readonly form
  const waitOnHold = <T>(promise: Promise<T>): Promise<T> => {
    entered.resolve();

    return promise;
  };

  const ctx: DaemonContext = {
    build: 'atc/test',
    daemonID: toDaemonID('d-1'),
    idempotencyRetentionMs: 86_400_000,
    collectSessions: () => [],
    collectSpawnDirs: assertUnreachable,
    collectAgents: assertUnreachable,
    collectFleet: () => (isFleetHeld ? waitOnHold(holds.fleet.promise) : Promise.resolve([])),
    loadLastUsedAgent: () => Promise.resolve('claude'),
    findAdapter: assertUnreachable,
    buildTargetAccess: () => new TargetAccess([]),
    hasListedPrincipal: assertUnreachable,
    findSessionGrant: () => ({ target: 'local', targetIdentity: 'local-pty' }),
    findTargetIdentity: assertUnreachable,
    canSeeSession: (id) => visible && !hidden.has(id),
    isSessionVisible: assertUnreachable,
    findPermissionSession: assertUnreachable,
    resolveSpawnParent: assertUnreachable,
    resolveSpawnTarget: assertUnreachable,
    requireWorkspaceTarget: assertUnreachable,
    findSource: assertUnreachable,
    checkRepositoryAccess: assertUnreachable,
    collectAlternateGitURLs: assertUnreachable,
    spawnSession: () => waitOnHold(holds.spawn.promise),
    killSession: assertUnreachable,
    forgetSession: assertUnreachable,
    revokeSessionAuth: assertUnreachable,
    updateSessionAuth: assertUnreachable,
    updateSession: assertUnreachable,
    quitDaemon: assertUnreachable,
    ackSession: assertUnreachable,
    buildResumeCommand: assertUnreachable,
    readSessionScreen: (id) =>
      id === 's-held' ? waitOnHold(holds.screen.promise) : Promise.resolve('missing'),
    readSessionRecord: (id) =>
      id === 's-held' ? waitOnHold(holds.record.promise) : Promise.resolve('missing'),
    loadSessionTranscript: (id) =>
      id === 's-held' ? waitOnHold(holds.transcript.promise) : Promise.resolve('missing'),
    readEvents: (_afterID, _limit, _waitMs, sessionID) =>
      sessionID === 's-held'
        ? waitOnHold(holds.events.promise)
        : Promise.resolve({ events: [], more: false }),
    readReport: (id) => (id === 1 ? waitOnHold(holds.report.promise) : Promise.resolve(null)),
    answerPermission: assertUnreachable,
    restoreFleet: assertUnreachable,
    attachSession: assertUnreachable,
    detachSession: () => {},
    detachClient: assertUnreachable,
    writeSessionInput: assertUnreachable,
    writeSessionLine: assertUnreachable,
    ejectSession: assertUnreachable,
    adoptSession: assertUnreachable,
    resizeSession: assertUnreachable,
    resyncClient: assertUnreachable,
    getEffectiveDims: assertUnreachable,
    writeSessionMessage: () => waitOnHold(holds.write.promise),
    readMessage: (id, waitMs) => {
      if (id !== 'm-held') {
        return Promise.resolve(null);
      }

      const view = {
        session: toSessionID('s-held'),
        record: {
          id: toMessageID('m-held'),
          atcID: toSessionID('s-held'),
          from: 'owner',
          text: 'secret',
          status: 'accepted' as const,
          sentAt: 0,
        },
        answeredWith: [],
      };

      return waitMs === 0 ? Promise.resolve(view) : waitOnHold(holds.message.promise);
    },
    attachTap: assertUnreachable,
    detachTap: () => {},
    ackMessage: (_client, sessionID) =>
      sessionID === 's-held' ? waitOnHold(holds.ack.promise) : Promise.resolve('unknown'),
  };

  const peer = {
    // oxlint-disable-next-line prefer-readonly-parameter-types -- a readonly view cannot satisfy the writer contract; the fake never mutates chunks
    write: (data: Uint8Array): number => {
      written += new TextDecoder().decode(data);

      return data.length;
    },
    end: () => {},
  };

  const conn = new DaemonConnection(peer, ctx);

  conn.applyChunk(
    `${JSON.stringify({ v: PROTOCOL_V, id: 1, m: 'daemon.hello', p: { client: 'atc/test', principal: 'narrow' } })}\n`,
  );

  return {
    holds,
    entered: entered.promise,
    setVisible: (value: boolean) => {
      visible = value;
    },
    hide: (id: string) => {
      hidden.add(id);
    },
    setFleetHeld: (value: boolean) => {
      isFleetHeld = value;
    },
    request: (m: string, p: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const id = nextID;

      nextID += 1;

      conn.applyChunk(`${JSON.stringify({ v: PROTOCOL_V, id, m, p })}\n`);

      return waitFor(() => {
        const frames: unknown[] = written
          .split('\n')
          .filter((line) => line !== '')
          .map((line): unknown => JSON.parse(line));

        const frame = frames.find(
          (candidate) =>
            typeof candidate === 'object' &&
            candidate !== null &&
            'id' in candidate &&
            candidate.id === id,
        );

        if (typeof frame !== 'object' || frame === null) {
          throw new Error(`no answer to request ${id} yet`);
        }

        const { id: _id, ...answer } = { ...frame, id };

        return answer;
      });
    },
  };
}

test('it answers session.get whose session leaves the view during the read as for a session that does not exist', async () => {
  const scoped = setupTest();
  const held = scoped.request('session.get', { session: 's-held' });

  await scoped.entered;

  scoped.setVisible(false);

  scoped.holds.record.resolve({
    session: {
      id: toSessionID('s-held'),
      name: 'secret',
      cwd: '/tmp',
      state: 'running',
      unread: false,
      lastMsg: 'secret',
      agent: 'claude',
      pinned: false,
      lastAttachedAt: 0,
      repoRoot: '/tmp',
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
  const unknown = await scoped.request('session.get', { session: 's-held' });

  expect(answered).toStrictEqual(unknown);
  expect(unknown).toMatchObject({ err: { code: 'no_such_session' } });
});

test('it answers session.screen whose session leaves the view during the read as for a session that does not exist', async () => {
  const scoped = setupTest();
  const held = scoped.request('session.screen', { session: 's-held' });

  await scoped.entered;

  scoped.setVisible(false);
  scoped.holds.screen.resolve({ text: 'secret', cols: 80, rows: 24 });

  const answered = await held;
  const unknown = await scoped.request('session.screen', { session: 's-held' });

  expect(answered).toStrictEqual(unknown);
  expect(unknown).toMatchObject({ err: { code: 'no_such_session' } });
});

test('it answers session.read whose session leaves the view during the read as for a session that does not exist', async () => {
  const scoped = setupTest();
  const held = scoped.request('session.read', { session: 's-held' });

  await scoped.entered;

  scoped.setVisible(false);

  scoped.holds.transcript.resolve({
    path: '/tmp/secret.jsonl',
    page: { rows: [], offset: 0, more: false },
  });

  const answered = await held;
  const unknown = await scoped.request('session.read', { session: 's-held' });

  expect(answered).toStrictEqual(unknown);
  expect(unknown).toMatchObject({ err: { code: 'no_such_session' } });
});

test('it leaves out of events.read the events of a session that leaves the view during the read', async () => {
  const scoped = setupTest();
  const held = scoped.request('events.read', { session: 's-held', waitMs: 0 });

  await scoped.entered;

  scoped.setVisible(false);

  scoped.holds.events.resolve({
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
  const unknown = await scoped.request('events.read', { session: 's-missing', waitMs: 0 });

  expect(answered).toStrictEqual(unknown);
  expect(unknown).toMatchObject({ ok: { events: [], more: false } });
});

test('it answers report.get whose session leaves the view during the read as for a report that does not exist', async () => {
  const scoped = setupTest();
  const held = scoped.request('report.get', { report: 'eyJrIjoiZXYiLCJpIjoxfQ' });

  await scoped.entered;

  scoped.setVisible(false);

  scoped.holds.report.resolve({
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
  const unknown = await scoped.request('report.get', { report: 'eyJrIjoiZXYiLCJpIjoyfQ' });

  expect(JSON.stringify(answered).replace('eyJrIjoiZXYiLCJpIjoxfQ', '<report>')).toBe(
    JSON.stringify(unknown).replace('eyJrIjoiZXYiLCJpIjoyfQ', '<report>'),
  );

  expect(unknown).toMatchObject({ err: { code: 'bad_args' } });
});

test('it answers report.get whose sender leaves the view during the read as for a report that does not exist, whatever session its view is named by', async () => {
  const scoped = setupTest();
  const held = scoped.request('report.get', { report: 'eyJrIjoiZXYiLCJpIjoxfQ' });

  await scoped.entered;

  scoped.hide('s-held');

  scoped.holds.report.resolve({
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
  const unknown = await scoped.request('report.get', { report: 'eyJrIjoiZXYiLCJpIjoyfQ' });

  expect(JSON.stringify(answered).replace('eyJrIjoiZXYiLCJpIjoxfQ', '<report>')).toBe(
    JSON.stringify(unknown).replace('eyJrIjoiZXYiLCJpIjoyfQ', '<report>'),
  );

  expect(JSON.stringify(answered)).not.toInclude('secret');
});

test('it answers message.get whose session leaves the view during the wait as for an unknown message', async () => {
  const scoped = setupTest();
  const held = scoped.request('message.get', { message: 'm-held', waitMs: 30_000 });

  await scoped.entered;

  scoped.setVisible(false);

  scoped.holds.message.resolve({
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
  const unknown = await scoped.request('message.get', { message: 'm-missing', waitMs: 0 });

  expect(JSON.stringify(answered).replace('m-held', '<message>')).toBe(
    JSON.stringify(unknown).replace('m-missing', '<message>'),
  );

  expect(unknown).toMatchObject({ err: { code: 'bad_args' } });
});

test('it answers message.ack whose session leaves the view during the ack as for an unknown message', async () => {
  const scoped = setupTest();
  const held = scoped.request('message.ack', { session: 's-held', message: 'm-held' });

  await scoped.entered;

  scoped.setVisible(false);

  scoped.holds.ack.resolve({
    id: toMessageID('m-held'),
    atcID: toSessionID('s-held'),
    from: 'owner',
    text: 'secret',
    status: 'delivered',
    sentAt: 0,
  });

  const answered = await held;
  const unknown = await scoped.request('message.ack', { session: 's-held', message: 'm-held' });

  expect(answered).toStrictEqual(unknown);
  expect(unknown).toMatchObject({ err: { code: 'bad_args' } });
});

test('it answers session.message whose session leaves the view during the write as for a session that does not exist', async () => {
  const scoped = setupTest();

  const held = scoped.request('session.message', {
    session: 's-held',
    from: 'remote',
    text: 'hello',
  });

  await scoped.entered;

  scoped.setVisible(false);
  scoped.holds.write.resolve({ message: 'm-1', status: 'accepted' });

  const answered = await held;

  const unknown = await scoped.request('session.message', {
    session: 's-held',
    from: 'remote',
    text: 'hello',
  });

  expect(answered).toStrictEqual(unknown);
  expect(unknown).toMatchObject({ err: { code: 'no_such_session' } });
});

test('it refuses a spawn whose session leaves the view before the answer as a replay out of reach is refused', async () => {
  const scoped = setupTest();
  const held = scoped.request('session.spawn', { cwd: '/tmp' });

  await scoped.entered;

  scoped.setVisible(false);

  scoped.holds.spawn.resolve({
    session: { id: 's-new', name: 'secret', locator: { daemonID: 'd-1', targetID: 'local' } },
  });

  const answered = await held;

  expect(answered).toStrictEqual({
    v: PROTOCOL_V,
    err: {
      code: 'target_forbidden',
      msg: expect.toInclude("'local'"),
      data: { target: 'local' },
    },
  });

  expect(JSON.stringify(answered)).not.toInclude('s-new');
});

test('it leaves out of fleet.list a session that leaves the view during the read', async () => {
  const scoped = setupTest();

  scoped.setFleetHeld(true);

  const held = scoped.request('fleet.list', {});

  await scoped.entered;

  scoped.setVisible(false);

  scoped.holds.fleet.resolve([
    { sessionID: toSessionID('s-held'), name: 'secret', cwd: '/tmp', agent: 'claude' },
  ]);

  const answered = await held;

  scoped.setFleetHeld(false);

  const unknown = await scoped.request('fleet.list', {});

  expect(answered).toStrictEqual(unknown);
  expect(unknown).toMatchObject({ ok: { fleet: [] } });
});
