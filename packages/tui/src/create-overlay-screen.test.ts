import { expect, test } from 'bun:test';
import { parseConfig } from '@atc/config';
import { KEYS, buildStubHarnessPlugins, buildStubTerminal } from '@atc/test-utils';
import { createFleetMirror } from './create-fleet-mirror';
import { createOverlayScreen } from './create-overlay-screen';
import type { OverlayConfirm } from './create-overlay-screen';
import type { SessionKey } from './session-key';
import { buildMockMirrorSession } from './testing/build-mock-mirror-session';

function setupTest() {
  const terminal = buildStubTerminal();
  const mirror = createFleetMirror(null);
  const confirm: { value: OverlayConfirm; key: SessionKey | null } = { value: 'none', key: null };

  const overlay = createOverlayScreen({
    mirror,
    bootMetadata: { labels: { claude: 'Claude' }, models: {} },
    readConfig: () => parseConfig(buildStubHarnessPlugins(), {}),
    links: {
      clientFor: () => null,
      stateOf: () => ({ kind: 'up' }),
      listDaemons: () => [null],
    },
    findFocusedKey: () => null,
    getMode: () => 'overlay',
    getConfirm: () => confirm.value,
    findConfirmKey: () => confirm.key,
    isBootStale: () => false,
    isDaemonRestarting: () => false,
    scheduleStatus: () => {},
    write: terminal.write,
  });

  const readHighlighted = () => {
    const frame = terminal.getText().split(`${KEYS.esc}[2J`).at(-1) ?? '';

    return frame.split(`${KEYS.esc}[7m`).at(1)?.split(`${KEYS.esc}[0m`).at(0) ?? '';
  };

  return { terminal, mirror, confirm, overlay, readHighlighted };
}

test('it highlights the session a kill confirmation opened on after the rows reorder', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'a', name: 'alpha', state: 'running' }));
  ctx.mirror.upsert(buildMockMirrorSession({ id: 'b', name: 'beta', state: 'exited' }));

  ctx.overlay.selected = ctx.overlay.pickSessions().findIndex((session) => session.id === 'a');
  ctx.confirm.value = 'kill';
  ctx.confirm.key = { daemon: null, id: 'a' };

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'b', name: 'beta', state: 'needs_you' }));
  ctx.overlay.render();

  expect(ctx.readHighlighted()).toInclude('alpha');
  expect(ctx.readHighlighted()).not.toInclude('beta');
});
