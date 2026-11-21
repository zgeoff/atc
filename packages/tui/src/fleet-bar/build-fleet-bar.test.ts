import { expect, test } from 'bun:test';
import { buildFleetBar } from './build-fleet-bar';
import type { FleetBarSession } from './types';

function setupTest() {
  const sessions: FleetBarSession[] = [
    { daemon: 'lab', state: 'done', place: { key: 'k-laptop', label: 'laptop' } },
    { daemon: 'lab', state: 'running', place: { key: 'k-laptop', label: 'laptop' } },
    { daemon: 'lab', state: 'needs_you', place: { key: 'k-laptop', label: 'laptop' } },
    { daemon: 'lab', state: 'exited', place: { key: 'k-laptop', label: 'laptop' } },
    { daemon: 'lab', state: 'running', place: { key: 'k-laptop', label: 'laptop' } },
    { daemon: 'lab', state: 'done', place: { key: 'k-laptop', label: 'laptop' } },
    { daemon: 'lab', state: 'running', place: { key: 'k-docker', label: 'docker' } },
    { daemon: 'lab', state: 'needs_you', place: { key: 'k-ink', label: 'ink' } },
    { daemon: 'lab', state: 'done', place: { key: 'k-ink', label: 'ink' } },
  ];

  return { sessions, options: { leaderLabel: 'ctrl+space', attachedPlaceKey: null } };
}

test('#buildFleetBar puts the attached place first and the others in label order', () => {
  const ctx = setupTest();
  const bar = buildFleetBar(ctx.sessions, { ...ctx.options, cols: 120, attachedPlaceKey: 'k-ink' });

  expect(bar.places.map((place) => place.label)).toStrictEqual(['ink', 'docker', 'laptop']);
});

test('#buildFleetBar sorts glyphs by state, keeps 4 and counts the rest', () => {
  const ctx = setupTest();
  const bar = buildFleetBar(ctx.sessions, { ...ctx.options, cols: 120 });

  expect(bar.places.find((place) => place.label === 'laptop')).toStrictEqual({
    label: 'laptop',
    colour: expect.objectContaining({ kind: 'rgb' }),
    glyphs: ['◆', '⠋', '⠋', '✓'],
    more: 2,
    count: 6,
    needYou: 1,
    reachable: true,
  });
});

test('#buildFleetBar counts the sessions that need you across every place', () => {
  const ctx = setupTest();

  expect(buildFleetBar(ctx.sessions, { ...ctx.options, cols: 120 })).toMatchObject({
    level: 'glyphs',
    dropped: 0,
    needYou: 2,
    leaderLabel: 'ctrl+space',
  });
});

test('#buildFleetBar moves a needs_you glyph into the rest only past 4 of them', () => {
  const bar = buildFleetBar(
    Array.from({ length: 5 }, () => ({
      daemon: 'lab',
      state: 'needs_you' as const,
      place: { key: 'k', label: 'big' },
    })),
    { leaderLabel: 'ctrl+space', attachedPlaceKey: null, cols: 120 },
  );

  expect([bar.places[0]?.glyphs, bar.places[0]?.more]).toStrictEqual([['◆', '◆', '◆', '◆'], 1]);
});

// the right end is 25 columns from 90 columns up and 16 below, and the bar keeps 3 columns of gap;
// the places need 36 columns at glyphs, 33 at counts and 27 at short, and 17 and 6 with the …
test.each([
  { cols: 100, level: 'glyphs', dropped: 0 },
  { cols: 55, level: 'glyphs', dropped: 0 },
  { cols: 54, level: 'counts', dropped: 0 },
  { cols: 52, level: 'counts', dropped: 0 },
  { cols: 51, level: 'short', dropped: 0 },
  { cols: 46, level: 'short', dropped: 0 },
  { cols: 45, level: 'short', dropped: 1 },
  { cols: 36, level: 'short', dropped: 1 },
  { cols: 35, level: 'short', dropped: 2 },
  { cols: 25, level: 'short', dropped: 2 },
  { cols: 24, level: 'short', dropped: 3 },
])('#buildFleetBar picks $level and drops $dropped places at $cols columns', (row) => {
  const ctx = setupTest();
  const bar = buildFleetBar(ctx.sessions, { ...ctx.options, cols: row.cols });

  expect([bar.level, bar.dropped]).toStrictEqual([row.level, row.dropped]);
});

test('#buildFleetBar marks a place unreachable while a daemon that serves it is down', () => {
  const ctx = setupTest();

  const bar = buildFleetBar(ctx.sessions, {
    ...ctx.options,
    cols: 120,
    downDaemons: new Set(['lab']),
  });

  expect([bar.places.map((place) => place.reachable), bar.needYou]).toStrictEqual([
    [false, false, false],
    2,
  ]);
});

test('#buildFleetBar turns the spinner with the frame', () => {
  const sessions: FleetBarSession[] = [
    { daemon: 'lab', state: 'running', place: { key: 'k', label: 'one' } },
  ];

  const options = { leaderLabel: 'ctrl+space', attachedPlaceKey: null, cols: 120 };

  expect([
    buildFleetBar(sessions, { ...options, spinnerFrame: 0 }).places[0]?.glyphs,
    buildFleetBar(sessions, { ...options, spinnerFrame: 1 }).places[0]?.glyphs,
  ]).toStrictEqual([['⠋'], ['⠙']]);
});
