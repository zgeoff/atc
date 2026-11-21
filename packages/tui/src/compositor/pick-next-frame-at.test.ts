import { expect, test } from 'bun:test';
import { isLateTick, pickNextFrameAt } from './pick-next-frame-at';

test.each<{ answers: (number | null)[]; expected: number | null }>([
  { answers: [], expected: null },
  { answers: [null, null], expected: null },
  { answers: [null, 140], expected: 140 },
  { answers: [300, 120, null, 200], expected: 120 },
])('#pickNextFrameAt picks $expected from $answers', (row) => {
  expect(pickNextFrameAt(row.answers)).toBe(row.expected);
});

test.each<{ dueAtMs: number; nowMs: number; expected: boolean }>([
  { dueAtMs: 100, nowMs: 100, expected: false },
  { dueAtMs: 100, nowMs: 116, expected: false },
  { dueAtMs: 100, nowMs: 117, expected: true },
  { dueAtMs: 100, nowMs: 90, expected: false },
])('#isLateTick answers $expected for a tick due at $dueAtMs seen at $nowMs', (row) => {
  expect(isLateTick(row.dueAtMs, row.nowMs, 16)).toBe(row.expected);
});
