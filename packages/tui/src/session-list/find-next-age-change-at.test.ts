import { expect, test } from 'bun:test';
import { findNextAgeChangeAt } from './find-next-age-change-at';
import { formatAge } from './format-age';

test.each([
  { title: 'the next second under a minute', since: 0, now: 4500, expected: 5000 },
  { title: 'the first minute at 59 s', since: 0, now: 59_999, expected: 60_000 },
  { title: 'the next minute under an hour', since: 0, now: 150_000, expected: 180_000 },
  { title: 'the next hour under a day', since: 0, now: 5_400_000, expected: 7_200_000 },
  { title: 'the next day past a day', since: 0, now: 90_000_000, expected: 172_800_000 },
  { title: 'one second after a start the TUI saw later', since: 2000, now: 1000, expected: 3000 },
])('#findNextAgeChangeAt gives $title', (row) => {
  expect(findNextAgeChangeAt('done', row.since, row.now)).toBe(row.expected);
});

test.each([
  { title: 'a running session', state: 'running', since: 0 },
  { title: 'a session in an unknown state', state: 'unknown', since: 0 },
  { title: 'a session whose state time the TUI never saw', state: 'done', since: null },
] as const)('#findNextAgeChangeAt gives null for $title', (row) => {
  expect(findNextAgeChangeAt(row.state, row.since, 1000)).toBeNull();
});

test.each([4500, 59_999, 150_000, 5_400_000, 90_000_000])(
  '#findNextAgeChangeAt gives the moment the age shown at %i ms changes, and no sooner',
  (nowMs) => {
    const next = findNextAgeChangeAt('done', 0, nowMs) ?? 0;
    const shown = formatAge('done', 0, nowMs);

    expect(formatAge('done', 0, next - 1)).toBe(shown);
    expect(formatAge('done', 0, next)).not.toBe(shown);
  },
);
