import { expect, onTestFinished, test } from 'bun:test';
import { parseConfig } from '@atc/config';
import { buildStubHarnessPlugins } from '@atc/config/test-utils/build-stub-harness-plugins';
import { KEYS } from '@atc/core/test-utils/keys';
import { createActor } from 'xstate';
import { createFleetMirror } from '../fleet/create-fleet-mirror';
import type { SessionKey } from '../fleet/session-key';
import { createOverlayScreen } from '../overlay/create-overlay-screen';
import { matchLeaderKey } from '../overlay/match-leader-key';
import { buildMockMirrorSession } from '../test-utils/build-mock-mirror-session';
import { buildStubClientScreens } from '../test-utils/build-stub-client-screens';
import { applyInputKey } from './apply-input-key';
import type { InputKeyDeps } from './apply-input-key';
import { buildClientMachine } from './build-client-machine';

function setupTest() {
  const service = createActor(buildClientMachine(buildStubClientScreens().deps));

  service.start();

  onTestFinished(() => {
    service.stop();
  });

  const mirror = createFleetMirror(null);
  const sent: string[] = [];

  const send = (name: string) => (key: SessionKey) => {
    sent.push(`${name}:${key.id}`);

    return Promise.resolve();
  };

  const links = {
    clientFor: () => null,
    stateOf: () => ({ kind: 'up' as const }),
    listDaemons: () => [null],
  };

  const overlay = createOverlayScreen({
    mirror,
    bootMetadata: { labels: { claude: 'Claude' }, models: {} },
    readConfig: () => parseConfig(buildStubHarnessPlugins(), {}),
    links,
    findFocusedKey: () => null,
    getMode: () => service.getSnapshot().value.mode,
    getConfirm: () => service.getSnapshot().value.confirm,
    findConfirmKey: () => service.getSnapshot().context.confirmKey,
    isBootStale: () => false,
    isDaemonRestarting: () => false,
    isDaemonWaiting: () => false,
    scheduleStatus: () => {},
    requestFrame: () => {},
  });

  const deps: InputKeyDeps = {
    service,
    mirror,
    overlay,
    actions: {
      sendKill: send('kill'),
      sendEnd: send('end'),
      sendPinned: send('pin'),
      adoptSession: send('adopt'),
      yankResume: send('yank'),
      recordActionFailure: () => {},
    },
    links,
    picker: { applyKey: () => {} },
    eject: { applyKey: () => {} },
    stdinDecoder: new TextDecoder(),
    getMode: () => service.getSnapshot().value.mode,
    getConfirm: () => service.getSnapshot().value.confirm,
    getBoot: () => ({ stale: false }),
    findFocusedKey: () => ({ daemon: null, id: 'api' }),
    findRestartConsent: () => null,
    isLeaderKey: (buf) => matchLeaderKey(0, buf.toString()) === 'press',
    showBase: () => {},
    attach: send('attach'),
    sendInput: (key, data) => {
      sent.push(`input:${key.id}:${JSON.stringify(data)}`);

      return Promise.resolve();
    },
    restoreFleet: () => Promise.resolve(),
    restartDaemonOnce: () => Promise.resolve(),
    logClientEvent: () => {},
    quit: () => {},
  };

  return {
    service,
    mirror,
    sent,
    overlay,
    press: (chunk: string) => {
      applyInputKey(Buffer.from(chunk), deps);
    },
  };
}

test('it attaches the row a jump label names when the label arrives in one chunk with a narrowing letter', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'api', name: 'api', lastAttachedAt: 3 }));
  ctx.mirror.upsert(buildMockMirrorSession({ id: 'app', name: 'app', lastAttachedAt: 2 }));
  ctx.mirror.upsert(buildMockMirrorSession({ id: 'web', name: 'web', lastAttachedAt: 1 }));
  ctx.service.send({ type: 'OVERLAY' });
  ctx.press('f');
  ctx.press('ps');

  expect(ctx.sent).toStrictEqual(['attach:app']);
});

test('it narrows jump mode by each letter of a chunk', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'api', name: 'api', lastAttachedAt: 3 }));
  ctx.mirror.upsert(buildMockMirrorSession({ id: 'app', name: 'app', lastAttachedAt: 2 }));
  ctx.mirror.upsert(buildMockMirrorSession({ id: 'web', name: 'web', lastAttachedAt: 1 }));
  ctx.service.send({ type: 'OVERLAY' });
  ctx.press('f');
  ctx.press('ap');

  expect(ctx.overlay.jump?.typed).toBe('ap');
});

test('it takes one letter off the filter for each backspace in a chunk', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'app', name: 'app' }));
  ctx.service.send({ type: 'OVERLAY' });
  ctx.press('/');
  ctx.press('ap');
  ctx.press(`${KEYS.backspace}${KEYS.backspace}`);

  expect(ctx.overlay.filter).toBe('');
});

test('it opens the filter, types it and attaches its match from one chunk', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'api', name: 'api', lastAttachedAt: 2 }));
  ctx.mirror.upsert(buildMockMirrorSession({ id: 'web', name: 'web', lastAttachedAt: 1 }));
  ctx.service.send({ type: 'OVERLAY' });
  ctx.press(`/web${KEYS.enter}`);

  expect({ filter: ctx.overlay.filter, sent: ctx.sent }).toStrictEqual({
    filter: 'web',
    sent: ['attach:web'],
  });
});

test('it opens the list on a leader that shares a chunk with a key, and gives the list that key', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'api', name: 'api' }));
  ctx.service.send({ type: 'ATTACH', key: { daemon: null, id: 'api' } });
  ctx.press(`${KEYS.ctrlSpace}i`);

  expect({ sent: ctx.sent, mode: ctx.service.getSnapshot().value.mode }).toStrictEqual({
    sent: [],
    mode: 'home',
  });
});

test('it sends the session the keys typed before a leader in the same chunk', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'api', name: 'api' }));
  ctx.service.send({ type: 'ATTACH', key: { daemon: null, id: 'api' } });
  ctx.press(`hi${KEYS.ctrlSpace}`);

  expect({ sent: ctx.sent, mode: ctx.service.getSnapshot().value.mode }).toStrictEqual({
    sent: ['input:api:"hi"'],
    mode: 'overlay',
  });
});

test('it sends the session a leader byte inside a paste', () => {
  const ctx = setupTest();
  const paste = `${KEYS.pasteOpen}a${KEYS.ctrlSpace}b${KEYS.pasteClose}`;

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'api', name: 'api' }));
  ctx.service.send({ type: 'ATTACH', key: { daemon: null, id: 'api' } });
  ctx.press(paste);

  expect({ sent: ctx.sent, mode: ctx.service.getSnapshot().value.mode }).toStrictEqual({
    sent: [`input:api:${JSON.stringify(paste)}`],
    mode: 'attached',
  });
});
