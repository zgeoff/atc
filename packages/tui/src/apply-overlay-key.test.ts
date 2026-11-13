import { expect, onTestFinished, test } from 'bun:test';
import { createActor } from 'xstate';
import { applyOverlayKey } from './apply-overlay-key';
import type { OverlayKeyDeps } from './apply-overlay-key';
import { buildClientMachine } from './build-client-machine';
import { createFleetMirror } from './create-fleet-mirror';
import type { DaemonLinkState } from './daemon-link-state';
import type { DaemonName, SessionKey } from './session-key';
import { buildMockMirrorSession } from './testing/build-mock-mirror-session';
import { buildStubClientScreens } from './testing/build-stub-client-screens';

function setupTest() {
  const service = createActor(buildClientMachine(buildStubClientScreens().deps));

  service.start();

  onTestFinished(() => {
    service.stop();
  });

  const mirror = createFleetMirror(null);
  const sent: string[] = [];

  const states = new Map<DaemonName, DaemonLinkState>([[null, { kind: 'up' }]]);

  const send = (name: string) => (key: SessionKey) => {
    sent.push(`${name}:${key.daemon ?? 'local'}/${key.id}`);

    return Promise.resolve();
  };

  const deps: OverlayKeyDeps = {
    service,
    mirror,
    overlay: {
      notice: null,
      selected: 0,
      filter: null,
      grouped: false,
      render: () => {},
      listVisible: () => mirror.sessions,
      pickSessions: () => mirror.sessions,
    },
    actions: {
      sendKill: send('kill'),
      sendForget: send('forget'),
      sendDestroy: send('destroy'),
      sendAck: send('ack'),
      sendPinned: send('pin'),
      adoptSession: send('adopt'),
      yankResume: send('yank'),
      recordActionFailure: () => {},
    },
    links: { stateOf: (daemon) => states.get(daemon) ?? { kind: 'connecting' } },
    getConfirm: () => service.getSnapshot().value.confirm,
    getBoot: () => ({ stale: false }),
    isLeaderKey: () => false,
    showBase: () => {},
    attach: send('attach'),
    restartDaemonOnce: () => Promise.resolve(),
    logClientEvent: () => {},
    quit: () => {},
  };

  const press = (key: string) => {
    applyOverlayKey(Buffer.from(key), deps);
  };

  return { service, mirror, sent, states, deps, press };
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

  ctx.mirror.upsert(buildMockMirrorSession({ daemon: null, id: 's-1' }));
  ctx.mirror.upsert(buildMockMirrorSession({ daemon: null, id: 's-2' }));
  ctx.press('K');

  ctx.deps.overlay.selected = 1;

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

test('it forgets an exited session on the daemon that holds it', () => {
  const ctx = setupTest();

  ctx.states.set('box', { kind: 'up' });
  ctx.mirror.upsert(buildMockMirrorSession({ daemon: 'box', id: 's-1', alive: false }));
  ctx.press('K');
  ctx.press('y');

  expect(ctx.sent).toStrictEqual(['forget:box/s-1']);
});

test('it attaches the selected row on its own daemon when two daemons hold the same id', () => {
  const ctx = setupTest();

  ctx.states.set('box', { kind: 'up' });
  ctx.mirror.upsert(buildMockMirrorSession({ daemon: null, id: 's-1' }));
  ctx.mirror.upsert(buildMockMirrorSession({ daemon: 'box', id: 's-1' }));
  ctx.press('\r');

  ctx.deps.overlay.selected = 1;

  ctx.press('\r');

  expect(ctx.sent).toStrictEqual(['attach:local/s-1', 'attach:box/s-1']);
});
