import { expect, test } from 'bun:test';
import { planVacatedRows } from './plan-vacated-rows';

test('it erases nothing on the first draw', () => {
  expect(planVacatedRows(null, { top: 5, height: 10 })).toStrictEqual([]);
});

test('it erases nothing when the box keeps its extent', () => {
  expect(planVacatedRows({ top: 5, height: 10 }, { top: 5, height: 10 })).toStrictEqual([]);
});

test('it erases the rows above and below a box that shrank and recentered', () => {
  expect(planVacatedRows({ top: 4, height: 12 }, { top: 7, height: 6 })).toStrictEqual([
    4, 5, 6, 13, 14, 15,
  ]);
});

test('it erases nothing when the box grows over its previous extent', () => {
  expect(planVacatedRows({ top: 7, height: 6 }, { top: 4, height: 12 })).toStrictEqual([]);
});

test('it erases every previous row when the extents do not overlap', () => {
  expect(planVacatedRows({ top: 2, height: 3 }, { top: 10, height: 3 })).toStrictEqual([2, 3, 4]);
});
