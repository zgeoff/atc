import { expect, test } from 'bun:test';
import { formatAge } from './format-age';

test.each([
  { title: 'blank for a running session', state: 'running', since: 0, now: 5000, expected: '' },
  {
    title: 'blank when the state time is null',
    state: 'done',
    since: null,
    now: 5000,
    expected: '',
  },
  { title: 'seconds under a minute', state: 'needs_you', since: 1000, now: 7999, expected: '6s' },
  {
    title: 'minutes under an hour',
    state: 'done',
    since: 0,
    now: 4 * 60_000 + 59_000,
    expected: '4m',
  },
  { title: 'hours under a day', state: 'exited', since: 0, now: 3 * 3_600_000, expected: '3h' },
  { title: 'days from a day on', state: 'exited', since: 0, now: 2 * 86_400_000, expected: '2d' },
] as const)('#formatAge gives $title', (row) => {
  expect(formatAge(row.state, row.since, row.now)).toBe(row.expected);
});
