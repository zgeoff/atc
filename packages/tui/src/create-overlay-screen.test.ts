import { expect, test } from 'bun:test';
import { parseConfig } from '@atc/config';
import { buildStubHarnessPlugins } from '@atc/config/test-utils/build-stub-harness-plugins';
import { KEYS } from '@atc/core/test-utils/keys';
import { createFleetMirror } from './create-fleet-mirror';
import { createOverlayScreen } from './create-overlay-screen';
import type { OverlayConfirm } from './create-overlay-screen';
import type { SessionKey } from './session-key';
import { buildMockMirrorSession } from './test-utils/build-mock-mirror-session';
import { buildStubTerminal } from './test-utils/build-stub-terminal';
import { collectOverlayHeaders } from './test-utils/collect-overlay-headers';

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
      listDaemons: () => [null, 'box'],
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

test('it groups the pinned sessions of every daemon under one pinned header at the top', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(
    buildMockMirrorSession({
      id: 'north',
      pinned: true,
      repoRoot: '/work/atlas',
      lastAttachedAt: 4,
    }),
  );

  ctx.mirror.upsert(
    buildMockMirrorSession({
      id: 'south',
      pinned: false,
      repoRoot: '/work/atlas',
      lastAttachedAt: 3,
    }),
  );

  ctx.mirror.upsert(
    buildMockMirrorSession({
      daemon: 'box',
      id: 'east',
      pinned: true,
      repoRoot: '/work/harbor',
      lastAttachedAt: 2,
    }),
  );

  ctx.mirror.upsert(
    buildMockMirrorSession({
      daemon: 'box',
      id: 'west',
      pinned: false,
      repoRoot: '/work/harbor',
      lastAttachedAt: 1,
    }),
  );

  ctx.overlay.grouped = true;

  const mark = ctx.terminal.countChunks();

  ctx.overlay.render();

  expect(collectOverlayHeaders(ctx.terminal.getTextSince(mark))).toStrictEqual([
    'pinned',
    '/work/atlas',
    '/work/harbor',
  ]);

  expect(ctx.overlay.pickSessions().map((session) => session.id)).toStrictEqual([
    'north',
    'east',
    'south',
    'west',
  ]);
});

test('it moves an unpinned remote session out of the one pinned group', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(
    buildMockMirrorSession({
      id: 'north',
      pinned: true,
      repoRoot: '/work/atlas',
      lastAttachedAt: 4,
    }),
  );

  ctx.mirror.upsert(
    buildMockMirrorSession({
      id: 'south',
      pinned: false,
      repoRoot: '/work/atlas',
      lastAttachedAt: 3,
    }),
  );

  ctx.mirror.upsert(
    buildMockMirrorSession({
      daemon: 'box',
      id: 'east',
      pinned: true,
      repoRoot: '/work/harbor',
      lastAttachedAt: 2,
    }),
  );

  ctx.mirror.upsert(
    buildMockMirrorSession({
      daemon: 'box',
      id: 'west',
      pinned: true,
      repoRoot: '/work/harbor',
      lastAttachedAt: 1,
    }),
  );

  ctx.overlay.grouped = true;

  ctx.overlay.render();

  ctx.mirror.upsert(
    buildMockMirrorSession({
      daemon: 'box',
      id: 'east',
      pinned: false,
      repoRoot: '/work/harbor',
      lastAttachedAt: 2,
    }),
  );

  const mark = ctx.terminal.countChunks();

  ctx.overlay.render();

  expect(collectOverlayHeaders(ctx.terminal.getTextSince(mark))).toStrictEqual([
    'pinned',
    '/work/atlas',
    '/work/harbor',
  ]);

  expect(ctx.overlay.pickSessions().map((session) => session.id)).toStrictEqual([
    'north',
    'west',
    'south',
    'east',
  ]);
});

test('it draws no pinned header once the only pinned session, on a remote daemon, is unpinned', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'south', repoRoot: '/work/atlas' }));

  ctx.mirror.upsert(
    buildMockMirrorSession({ daemon: 'box', id: 'east', pinned: true, repoRoot: '/work/harbor' }),
  );

  ctx.overlay.grouped = true;

  ctx.overlay.render();

  ctx.mirror.upsert(
    buildMockMirrorSession({ daemon: 'box', id: 'east', pinned: false, repoRoot: '/work/harbor' }),
  );

  const mark = ctx.terminal.countChunks();

  ctx.overlay.render();

  expect(collectOverlayHeaders(ctx.terminal.getTextSince(mark))).toStrictEqual([
    '/work/atlas',
    '/work/harbor',
  ]);
});
