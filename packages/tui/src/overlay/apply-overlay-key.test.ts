import { expect, onTestFinished, test } from 'bun:test';
import { parseConfig } from '@atc/config';
import { buildStubHarnessPlugins } from '@atc/config/test-utils/build-stub-harness-plugins';
import { createActor } from 'xstate';
import { buildClientMachine } from '../client/build-client-machine';
import type { DaemonLinkState } from '../daemon-link/daemon-link-state';
import { createFleetMirror } from '../fleet/create-fleet-mirror';
import type { DaemonName, SessionKey } from '../fleet/session-key';
import { buildMockMirrorSession } from '../test-utils/build-mock-mirror-session';
import { buildStubClientScreens } from '../test-utils/build-stub-client-screens';
import { applyOverlayKey } from './apply-overlay-key';
import type { OverlayKeyDeps } from './apply-overlay-key';
import { createOverlayScreen } from './create-overlay-screen';

function setupTest() {
  const service = createActor(buildClientMachine(buildStubClientScreens().deps));

  service.start();
  service.send({ type: 'OVERLAY' });

  onTestFinished(() => {
    service.stop();
  });

  const mirror = createFleetMirror(null);
  const sent: string[] = [];
  const state = { isLeader: false, baseShown: 0 };

  const states = new Map<DaemonName, DaemonLinkState>([[null, { kind: 'up' }]]);

  const send = (name: string) => (key: SessionKey) => {
    sent.push(`${name}:${key.daemon ?? 'local'}/${key.id}`);

    return Promise.resolve();
  };

  const links = {
    clientFor: () => null,
    stateOf: (daemon: DaemonName) => states.get(daemon) ?? { kind: 'connecting' as const },
    listDaemons: () => [null, 'box'],
  };

  const overlay = createOverlayScreen({
    mirror,
    bootMetadata: { labels: { claude: 'Claude' }, models: {} },
    readConfig: () => parseConfig(buildStubHarnessPlugins(), {}),
    links,
    findFocusedKey: () => null,
    getMode: () => 'overlay',
    getConfirm: () => service.getSnapshot().value.confirm,
    findConfirmKey: () => service.getSnapshot().context.confirmKey,
    isBootStale: () => false,
    isDaemonRestarting: () => false,
    isDaemonWaiting: () => false,
    scheduleStatus: () => {},
    requestFrame: () => {},
  });

  const deps: OverlayKeyDeps = {
    service,
    mirror,
    overlay,
    actions: {
      sendKill: send('kill'),
      sendEnd: (key, namesMachine) => send(`end-${namesMachine ? 'named' : 'plain'}`)(key),
      sendPinned: send('pin'),
      adoptSession: send('adopt'),
      yankResume: send('yank'),
      recordActionFailure: () => {},
    },
    links,
    getConfirm: () => service.getSnapshot().value.confirm,
    getBoot: () => ({ stale: false }),
    isLeaderKey: () => state.isLeader,
    showBase: () => {
      state.baseShown += 1;
    },
    attach: send('attach'),
    restartDaemonOnce: () => Promise.resolve(),
    logClientEvent: () => {},
    quit: () => {},
  };

  const press = (key: string) => {
    applyOverlayKey(Buffer.from(key), deps);
  };

  return { service, mirror, sent, states, state, overlay, press };
}

test('it kills the session on the daemon the kill confirmation opened on', () => {
  const ctx = setupTest();

  ctx.states.set('box', { kind: 'up' });
  ctx.mirror.upsert(buildMockMirrorSession({ daemon: 'box', id: 's-1' }));
  ctx.press('K');
  ctx.press('y');

  expect(ctx.sent).toStrictEqual(['kill:box/s-1']);
});

test('it kills the session the confirmation opened on, not the row selected after it', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ daemon: null, id: 's-1', lastAttachedAt: 2 }));
  ctx.mirror.upsert(buildMockMirrorSession({ daemon: null, id: 's-2', lastAttachedAt: 1 }));
  ctx.press('K');
  ctx.overlay.select(1);
  ctx.press('y');

  expect(ctx.sent).toStrictEqual(['kill:local/s-1']);
});

test('it cancels a kill confirmation opened on a remote row whose daemon dropped, and kills nothing', () => {
  const ctx = setupTest();

  ctx.states.set('box', { kind: 'up' });
  ctx.mirror.upsert(buildMockMirrorSession({ daemon: 'box', id: 's-1' }));
  ctx.press('K');
  ctx.states.set('box', { kind: 'down', detail: 'the connection dropped' });
  ctx.press('y');

  expect({ sent: ctx.sent, confirm: ctx.service.getSnapshot().value.confirm }).toStrictEqual({
    sent: [],
    confirm: 'none',
  });
});

test('it cancels a kill confirmation whose session left the list, and kills nothing', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ daemon: null, id: 's-1' }));
  ctx.press('K');

  ctx.mirror.sessions = [];

  ctx.press('y');

  expect(ctx.sent).toStrictEqual([]);
});

test('it asks nothing when K is pressed on a dead session', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ daemon: null, id: 's-1', alive: false }));
  ctx.press('K');

  expect(ctx.service.getSnapshot().value.confirm).toBe('none');
});

test('it sends no end before the user answers y', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ daemon: null, id: 's-1', alive: false }));
  ctx.press('X');

  expect({ sent: ctx.sent, confirm: ctx.service.getSnapshot().value.confirm }).toStrictEqual({
    sent: [],
    confirm: 'end',
  });
});

test('it ends a dead session on the daemon that holds it, with a question that names no machine', () => {
  const ctx = setupTest();

  ctx.states.set('box', { kind: 'up' });
  ctx.mirror.upsert(buildMockMirrorSession({ daemon: 'box', id: 's-1', alive: false }));
  ctx.press('X');
  ctx.press('y');

  expect(ctx.sent).toStrictEqual(['end-plain:box/s-1']);
});

test('it ends a session whose question named the machine with the token sent at once', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ daemon: null, id: 's-1', canDestroyHost: true }));
  ctx.press('X');
  ctx.press('y');

  expect(ctx.sent).toStrictEqual(['end-named:local/s-1']);
});

test('it ends nothing when the user answers the end question with another key', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ daemon: null, id: 's-1' }));
  ctx.press('X');
  ctx.press('n');

  expect({ sent: ctx.sent, confirm: ctx.service.getSnapshot().value.confirm }).toStrictEqual({
    sent: [],
    confirm: 'none',
  });
});

test('it shows the unpin notice for a pinned session and sends nothing', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(
    buildMockMirrorSession({ daemon: null, id: 's-1', name: 'orders', pinned: true }),
  );

  ctx.press('X');

  expect({
    notice: ctx.overlay.notice,
    sent: ctx.sent,
    confirm: ctx.service.getSnapshot().value.confirm,
  }).toStrictEqual({ notice: 'unpin orders first', sent: [], confirm: 'none' });
});

test('it attaches the selected row on its own daemon when two daemons hold the same id', () => {
  const ctx = setupTest();

  ctx.states.set('box', { kind: 'up' });
  ctx.mirror.upsert(buildMockMirrorSession({ daemon: null, id: 's-1', lastAttachedAt: 2 }));
  ctx.mirror.upsert(buildMockMirrorSession({ daemon: 'box', id: 's-1', lastAttachedAt: 1 }));
  ctx.press('\r');
  ctx.overlay.select(1);
  ctx.press('\r');

  expect(ctx.sent).toStrictEqual(['attach:local/s-1', 'attach:box/s-1']);
});

test('it cycles the grouping from flat to repo, to place, and back to flat with g', () => {
  const ctx = setupTest();
  const seen = [ctx.overlay.grouping];

  for (const key of ['g', 'g', 'g']) {
    ctx.press(key);
    seen.push(ctx.overlay.grouping);
  }

  expect(seen).toStrictEqual(['flat', 'repo', 'place', 'flat']);
});

test('it binds no key to marking a session read', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ daemon: null, id: 's-1', state: 'needs_you' }));
  ctx.press('a');

  expect(ctx.sent).toStrictEqual([]);
});

test('it goes home with i', () => {
  const ctx = setupTest();

  ctx.press('i');

  expect(ctx.service.getSnapshot().value.mode).toBe('home');
});

test('it closes the list on the leader key, and drops a question that was open', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ daemon: null, id: 's-1' }));
  ctx.press('X');

  ctx.state.isLeader = true;

  ctx.press('\u0000');

  expect({
    closed: ctx.state.baseShown,
    confirm: ctx.service.getSnapshot().value.confirm,
  }).toStrictEqual({ closed: 1, confirm: 'none' });
});

test.each([
  { title: 'a single-letter label', keys: ['f', 'd'], expected: ['attach:local/app'] },
  {
    title: 'a label of the rows that a typed letter narrowed',
    keys: ['f', 'p', 's'],
    expected: ['attach:local/app'],
  },
  {
    title: 'a backspace that takes the typed letter back',
    keys: ['f', 'p', '\u007F', 'd'],
    expected: ['attach:local/app'],
  },
  { title: 'no attach for a letter that matches no row', keys: ['f', 'q', 'q'], expected: [] },
])('it jumps with $title', (row) => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'api', name: 'api', lastAttachedAt: 3 }));
  ctx.mirror.upsert(buildMockMirrorSession({ id: 'app', name: 'app', lastAttachedAt: 2 }));
  ctx.mirror.upsert(buildMockMirrorSession({ id: 'web', name: 'web', lastAttachedAt: 1 }));

  for (const key of row.keys) {
    ctx.press(key);
  }

  expect(ctx.sent).toStrictEqual([...row.expected]);
});

test('it moves the selection to a dead row a jump label names, and attaches nothing', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'api', name: 'api', lastAttachedAt: 3 }));

  ctx.mirror.upsert(
    buildMockMirrorSession({ id: 'old', name: 'old', alive: false, state: 'exited' }),
  );

  ctx.press('f');
  ctx.press('f');

  expect({
    sent: ctx.sent,
    selected: ctx.overlay.pickSessions()[ctx.overlay.selected]?.id,
    jump: ctx.overlay.jump,
  }).toStrictEqual({ sent: [], selected: 'old', jump: null });
});

test('it leaves jump mode on escape and keeps the list open', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'api', name: 'api' }));
  ctx.press('f');
  ctx.press('\u001B');

  expect({ jump: ctx.overlay.jump, closed: ctx.state.baseShown }).toStrictEqual({
    jump: null,
    closed: 0,
  });
});
