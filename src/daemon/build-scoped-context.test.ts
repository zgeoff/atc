import { expect, test } from 'bun:test';
import type { SessionID } from '../shared/session-id';
import { toDaemonID } from '../shared/to-daemon-id';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import { buildScopedContext } from './build-scoped-context';
import type { DaemonContext } from './daemon-context';
import { TargetAccess } from './target-access';

function assertUnreachable(): never {
  throw new Error('unreachable in this test');
}

/**
 * A principal's view of a daemon whose session reads each wait on a
 * deferred promise the test settles. `visible` holds the sessions whose
 * whole tree the principal reaches. `readMessage` answers a wait of zero at
 * once from `messages`, and holds a longer wait on `message`, settling
 * `waiting` when that wait starts.
 */
function setupTest() {
  const visible = new Set<SessionID>();
  const messages = new Map<string, Awaited<ReturnType<DaemonContext['readMessage']>>>();

  const record = Promise.withResolvers<Awaited<ReturnType<DaemonContext['readSessionRecord']>>>();
  const screen = Promise.withResolvers<Awaited<ReturnType<DaemonContext['readSessionScreen']>>>();

  const transcript =
    Promise.withResolvers<Awaited<ReturnType<DaemonContext['loadSessionTranscript']>>>();

  const message = Promise.withResolvers<Awaited<ReturnType<DaemonContext['readMessage']>>>();
  const waiting = Promise.withResolvers<void>();

  const ctx: DaemonContext = {
    build: 'atc/test',
    daemonID: toDaemonID('d-1'),
    collectSessions: assertUnreachable,
    collectSpawnDirs: assertUnreachable,
    collectAgents: assertUnreachable,
    collectFleet: assertUnreachable,
    loadLastUsedAgent: assertUnreachable,
    findAdapter: assertUnreachable,
    buildTargetAccess: assertUnreachable,
    findSessionGrant: assertUnreachable,
    findTargetIdentity: assertUnreachable,
    canSeeSession: (id) => visible.has(id),
    findPermissionSession: assertUnreachable,
    resolveSpawnParent: assertUnreachable,
    resolveSpawnTarget: assertUnreachable,
    requireWorkspaceTarget: assertUnreachable,
    spawnSession: assertUnreachable,
    killSession: assertUnreachable,
    forgetSession: assertUnreachable,
    updateSession: assertUnreachable,
    quitDaemon: assertUnreachable,
    ackSession: assertUnreachable,
    buildResumeCommand: assertUnreachable,
    readSessionScreen: () => screen.promise,
    readSessionRecord: () => record.promise,
    loadSessionTranscript: () => transcript.promise,
    readEvents: assertUnreachable,
    readReport: assertUnreachable,
    answerPermission: assertUnreachable,
    restoreFleet: assertUnreachable,
    attachSession: assertUnreachable,
    detachSession: assertUnreachable,
    detachClient: assertUnreachable,
    writeSessionInput: assertUnreachable,
    writeSessionLine: assertUnreachable,
    ejectSession: assertUnreachable,
    adoptSession: assertUnreachable,
    resizeSession: assertUnreachable,
    resyncClient: assertUnreachable,
    getEffectiveDims: assertUnreachable,
    writeSessionMessage: assertUnreachable,
    readMessage: (id, waitMs) => {
      if (waitMs === 0) {
        return Promise.resolve(messages.get(id) ?? null);
      }

      waiting.resolve();

      return message.promise;
    },
    attachTap: assertUnreachable,
    detachTap: assertUnreachable,
    ackMessage: assertUnreachable,
  };

  return {
    context: buildScopedContext(ctx, new TargetAccess([]), 'client:narrow'),
    visible,
    messages,
    record,
    screen,
    transcript,
    message,
    waiting,
  };
}

test('it answers session.get for a session whose tree leaves the view during the read as for a session that does not exist', async () => {
  const scoped = setupTest();
  const id = toSessionID('s-1');

  scoped.visible.add(id);

  const answer = scoped.context.readSessionRecord(id, null);

  scoped.visible.delete(id);

  scoped.record.resolve({
    session: {
      id,
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

  const unknown = await scoped.context.readSessionRecord(toSessionID('s-missing'), null);
  const answered = await answer;

  expect(answered).toBe(unknown);
  expect(unknown).toBe('missing');
});

test('it answers session.screen for a session whose tree leaves the view during the read as for a session that does not exist', async () => {
  const scoped = setupTest();
  const id = toSessionID('s-1');

  scoped.visible.add(id);

  const answer = scoped.context.readSessionScreen(id);

  scoped.visible.delete(id);
  scoped.screen.resolve({ text: 'secret', cols: 80, rows: 24 });

  const unknown = await scoped.context.readSessionScreen(toSessionID('s-missing'));
  const answered = await answer;

  expect(answered).toBe(unknown);
  expect(unknown).toBe('missing');
});

test('it answers session.read for a session whose tree leaves the view during the read as for a session that does not exist', async () => {
  const scoped = setupTest();
  const id = toSessionID('s-1');

  scoped.visible.add(id);

  const answer = scoped.context.loadSessionTranscript(id, null, 10);

  scoped.visible.delete(id);

  scoped.transcript.resolve({
    path: '/tmp/secret.jsonl',
    page: { rows: [], offset: 0, more: false },
  });

  const unknown = await scoped.context.loadSessionTranscript(toSessionID('s-missing'), null, 10);
  const answered = await answer;

  expect(answered).toBe(unknown);
  expect(unknown).toBe('missing');
});

test('it answers message.get whose session leaves the view during the wait as for an unknown message', async () => {
  const scoped = setupTest();
  const id = toSessionID('s-1');
  const messageID = toMessageID('m-1');

  const view = {
    session: id,
    record: {
      id: messageID,
      atcID: id,
      from: 'owner',
      text: 'secret',
      status: 'accepted' as const,
      sentAt: 0,
    },
    answeredWith: [],
  };

  scoped.visible.add(id);
  scoped.messages.set(messageID, view);

  const answer = scoped.context.readMessage(messageID, 30_000);

  await scoped.waiting.promise;

  scoped.visible.delete(id);
  scoped.message.resolve({ ...view, record: { ...view.record, status: 'delivered' } });

  const unknown = await scoped.context.readMessage(toMessageID('m-missing'), 0);
  const answered = await answer;

  expect(answered).toBe(unknown);
  expect(unknown).toBeNull();
});
