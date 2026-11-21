import { expect, test } from 'bun:test';
import { parseConfig } from '@atc/config';
import { buildStubHarnessPlugins } from '@atc/config/test-utils/build-stub-harness-plugins';
import { createFleetMirror } from '../fleet/create-fleet-mirror';
import type { SessionKey } from '../fleet/session-key';
import { buildMockMirrorSession } from '../test-utils/build-mock-mirror-session';
import { createOverlayScreen } from './create-overlay-screen';
import type { OverlayConfirm } from './create-overlay-screen';

function setupTest(file: Record<string, unknown> = {}) {
  const mirror = createFleetMirror(null);
  const confirm: { value: OverlayConfirm; key: SessionKey | null } = { value: 'none', key: null };
  const state = { isStale: false, isWaiting: false, frames: 0 };

  const overlay = createOverlayScreen({
    mirror,
    bootMetadata: { labels: { claude: 'Claude' }, models: {} },
    readConfig: () => parseConfig(buildStubHarnessPlugins(), file),
    links: {
      clientFor: () => null,
      stateOf: (daemon) =>
        daemon === 'lab' ? { kind: 'down', detail: 'refused' } : { kind: 'up' },
      listDaemons: () => [null, 'box', 'lab'],
    },
    findFocusedKey: () => null,
    getMode: () => 'overlay',
    getConfirm: () => confirm.value,
    findConfirmKey: () => confirm.key,
    isBootStale: () => state.isStale,
    isDaemonRestarting: () => false,
    isDaemonWaiting: () => state.isWaiting,
    scheduleStatus: () => {},
    requestFrame: () => {
      state.frames += 1;
    },
  });

  return { mirror, confirm, state, overlay };
}

test('it selects the session a kill confirmation opened on after the rows reorder', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'a', name: 'alpha', state: 'running' }));
  ctx.mirror.upsert(buildMockMirrorSession({ id: 'b', name: 'beta', state: 'exited' }));
  ctx.overlay.select(ctx.overlay.pickSessions().findIndex((session) => session.id === 'a'));

  ctx.confirm.value = 'kill';
  ctx.confirm.key = { daemon: null, id: 'a' };

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'b', name: 'beta', state: 'needs_you' }));

  const input = ctx.overlay.readInput(0, 0);
  const sessions = input.rows.flatMap((row) => (row.kind === 'session' ? [row.session.id] : []));

  expect(sessions[input.selected]).toBe('a');
});

test('it keeps the selection on its session when another session moves above it', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'a', name: 'alpha', state: 'running' }));
  ctx.mirror.upsert(buildMockMirrorSession({ id: 'b', name: 'beta', state: 'running' }));
  ctx.overlay.select(ctx.overlay.pickSessions().findIndex((session) => session.id === 'b'));
  ctx.mirror.upsert(buildMockMirrorSession({ id: 'a', name: 'alpha', state: 'needs_you' }));

  const input = ctx.overlay.readInput(0, 0);
  const sessions = input.rows.flatMap((row) => (row.kind === 'session' ? [row.session.id] : []));

  expect(sessions[input.selected]).toBe('b');
});

test('it starts grouped as the config sets', () => {
  const ctx = setupTest({ list: { grouping: 'place' } });

  expect(ctx.overlay.grouping).toBe('place');
});

test('it puts the pinned sessions of every daemon under one pinned header at the top', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'north', pinned: true, repoRoot: '/work/atlas' }));
  ctx.mirror.upsert(buildMockMirrorSession({ id: 'south', repoRoot: '/work/atlas' }));

  ctx.mirror.upsert(
    buildMockMirrorSession({ daemon: 'box', id: 'east', pinned: true, repoRoot: '/work/harbor' }),
  );

  ctx.overlay.grouping = 'repo';

  const labels = ctx.overlay
    .readInput(0, 0)
    .rows.flatMap((row) => (row.kind === 'header' ? [row.label] : []));

  expect(labels).toStrictEqual(['pinned', 'atlas']);
});

test('it narrows the rows to the names that hold the typed jump letters', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'a', name: 'api' }));
  ctx.mirror.upsert(buildMockMirrorSession({ id: 'b', name: 'web' }));

  ctx.overlay.jump = { typed: 'w', prefix: '' };

  expect(ctx.overlay.pickSessions().map((session) => session.name)).toStrictEqual(['web']);
});

test('it labels each row while jump mode runs', () => {
  const ctx = setupTest();

  ctx.mirror.upsert(buildMockMirrorSession({ id: 'a', name: 'api', lastAttachedAt: 2 }));
  ctx.mirror.upsert(buildMockMirrorSession({ id: 'b', name: 'web', lastAttachedAt: 1 }));

  ctx.overlay.jump = { typed: '', prefix: '' };

  expect(ctx.overlay.readInput(0, 0).jump?.labels).toStrictEqual(['s', 'd']);
});

test('it words a line for a daemon that is down and the advice to update', () => {
  const ctx = setupTest();

  ctx.state.isStale = true;

  const input = ctx.overlay.readInput(0, 0);

  expect([input.daemonLine, input.updateAdvice]).toStrictEqual([
    expect.toInclude('lab'),
    'daemon runs an older build · u update daemon',
  ]);
});

test('it asks the screen for a frame when it renders', () => {
  const ctx = setupTest();

  ctx.overlay.render();

  expect(ctx.state.frames).toBe(1);
});
