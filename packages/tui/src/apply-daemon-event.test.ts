import { expect, onTestFinished, test } from 'bun:test';
import { createActor } from 'xstate';
import { applyDaemonEvent } from './apply-daemon-event';
import type { DaemonEventDeps } from './apply-daemon-event';
import { buildClientMachine } from './build-client-machine';
import { createFleetMirror } from './create-fleet-mirror';
import type { SessionKey } from './session-key';
import { buildMockMirrorSession } from './testing/build-mock-mirror-session';
import { buildStubClientScreens } from './testing/build-stub-client-screens';

function setupTest() {
  const service = createActor(buildClientMachine(buildStubClientScreens().deps));

  service.start();

  onTestFinished(() => {
    service.stop();
  });

  const mirror = createFleetMirror(null);
  let focused: SessionKey | null = null;

  mirror.upsert(
    buildMockMirrorSession({ daemon: null, id: 's-1', name: 'near', state: 'running' }),
  );

  mirror.upsert(
    buildMockMirrorSession({ daemon: 'box', id: 's-1', name: 'far', state: 'running' }),
  );

  const deps: DaemonEventDeps = {
    service,
    mirror,
    overlay: { render: () => {} },
    clock: { now: () => 5000, schedule: () => () => {} },
    getMode: () => 'overlay',
    findFocusedKey: () => focused,
    setFocusedKey: (key) => {
      focused = key;
    },
    setLastUsedAgent: () => {},
    findFocused: () => null,
    scheduleStatus: () => {},
  };

  const apply = (daemon: string | null, raw: Parameters<typeof applyDaemonEvent>[1]) => {
    applyDaemonEvent(daemon, raw, deps);
  };

  return { mirror, apply, focus: (key: SessionKey) => (focused = key), getFocused: () => focused };
}

test('it renames only the row of the daemon the event came from', () => {
  const ctx = setupTest();

  ctx.apply('box', {
    ev: 'SessionRenamed',
    sessionID: 's-1',
    name: 'far-renamed',
    namedBy: 'user',
  });

  expect(ctx.mirror.sessions.map((session) => [session.daemon, session.name])).toStrictEqual([
    [null, 'near'],
    ['box', 'far-renamed'],
  ]);
});

test('it removes only the row of the daemon the event came from, and its done time', () => {
  const ctx = setupTest();

  ctx.mirror.doneAt.set({ daemon: null, id: 's-1' }, 1);
  ctx.mirror.doneAt.set({ daemon: 'box', id: 's-1' }, 2);
  ctx.apply('box', { ev: 'SessionRemoved', sessionID: 's-1' });

  expect({
    rows: ctx.mirror.sessions.map((session) => session.daemon),
    doneAt: [
      ctx.mirror.doneAt.get({ daemon: null, id: 's-1' }),
      ctx.mirror.doneAt.get({ daemon: 'box', id: 's-1' }),
    ],
  }).toStrictEqual({ rows: [null], doneAt: [1, undefined] });
});

test('it clears the focus only when the removed session is the focused one on its daemon', () => {
  const ctx = setupTest();

  ctx.focus({ daemon: null, id: 's-1' });
  ctx.apply('box', { ev: 'SessionRemoved', sessionID: 's-1' });

  expect(ctx.getFocused()).toStrictEqual({ daemon: null, id: 's-1' });
});

test('it records the done time of the session on the daemon whose state flipped', () => {
  const ctx = setupTest();

  ctx.apply('box', {
    ev: 'SessionState',
    session: {
      id: 's-1',
      name: 'far',
      cwd: '/repo',
      state: 'done',
      unread: false,
      lastMsg: 'hi',
      createdAt: 1000,
      alive: true,
    },
  });

  expect([
    ctx.mirror.doneAt.get({ daemon: null, id: 's-1' }),
    ctx.mirror.doneAt.get({ daemon: 'box', id: 's-1' }),
  ]).toStrictEqual([undefined, 5000]);
});
