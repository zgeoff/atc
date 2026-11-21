import { expect, test } from 'bun:test';
import { pickListMotion } from './pick-list-motion';

test.each([
  { title: 'nothing at the first moment of the open', now: 1000, expected: [0, 0, true] },
  { title: 'half the frame at 90 ms', now: 1090, expected: [0.5, 0.5, true] },
  { title: 'the whole frame at 180 ms, with rows still moving', now: 1180, expected: [1, 1, true] },
  { title: 'nothing moving at 512 ms, the end of 15 rows', now: 1512, expected: [1, 1, false] },
])('#pickListMotion gives $title', (row) => {
  const motion = pickListMotion({ kind: 'opening', startedAtMs: 1000 }, row.now, {
    animations: true,
    rowCount: 15,
  });

  expect([motion.dim, motion.frame, motion.isMoving]).toStrictEqual([...row.expected]);
});

test('#pickListMotion gives row 0 half in at 170 ms', () => {
  expect(
    pickListMotion({ kind: 'opening', startedAtMs: 1000 }, 1170, {
      animations: true,
      rowCount: 15,
    }).row(0),
  ).toBe(0.5);
});

test('#pickListMotion gives row 14 its fade from 332 ms to 512 ms', () => {
  const motion = pickListMotion({ kind: 'opening', startedAtMs: 1000 }, 1422, {
    animations: true,
    rowCount: 15,
  });

  expect(motion.row(14)).toBe(0.5);
});

test.each([
  {
    title: 'the whole panel at the first moment of the close',
    now: 1000,
    expected: [1, true, true],
  },
  { title: 'half the panel at 60 ms', now: 1060, expected: [0.5, true, true] },
  { title: 'nothing at 120 ms', now: 1120, expected: [0, false, false] },
])('#pickListMotion gives $title', (row) => {
  const motion = pickListMotion({ kind: 'closing', startedAtMs: 1000 }, row.now, {
    animations: true,
    rowCount: 15,
  });

  expect([motion.frame, motion.isVisible, motion.isMoving]).toStrictEqual([...row.expected]);
});

test('#pickListMotion gives the whole panel at once with animations off', () => {
  const motion = pickListMotion({ kind: 'opening', startedAtMs: 1000 }, 1000, {
    animations: false,
    rowCount: 15,
  });

  expect([motion.dim, motion.frame, motion.row(14), motion.isMoving]).toStrictEqual([
    1,
    1,
    1,
    false,
  ]);
});

test('#pickListMotion gives no panel at once on a close with animations off', () => {
  const motion = pickListMotion({ kind: 'closing', startedAtMs: 1000 }, 1000, {
    animations: false,
    rowCount: 15,
  });

  expect(motion.isVisible).toBeFalse();
});

test('#pickListMotion gives no panel when closed', () => {
  expect(
    pickListMotion({ kind: 'closed' }, 1000, { animations: true, rowCount: 15 }).isVisible,
  ).toBeFalse();
});
