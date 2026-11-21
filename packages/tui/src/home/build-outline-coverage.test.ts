import { expect, test } from 'bun:test';
import { buildOutlineCoverage } from './build-outline-coverage';
import { OUTLINE_SIZES } from './constants';

function setupTest() {
  const coverage = buildOutlineCoverage(OUTLINE_SIZES.s10);

  const readPixels = (rows: readonly number[], cols: readonly number[]): number[] =>
    rows.flatMap((row) => cols.map((col) => coverage[row]?.[col] ?? Number.NaN));

  return { coverage, readPixels };
}

test('#buildOutlineCoverage gives s10 a canvas of the letters and the tracks', () => {
  const ctx = setupTest();

  expect([ctx.coverage.length, ctx.coverage[0]?.length]).toStrictEqual([14, 36]);
});

test('#buildOutlineCoverage pads an odd canvas to a whole number of cells', () => {
  const coverage = buildOutlineCoverage(OUTLINE_SIZES.xs8);

  expect([coverage.length, coverage[0]?.length]).toStrictEqual([12, 30]);
});

test('#buildOutlineCoverage covers every pixel of a straight edge fully or not at all', () => {
  const ctx = setupTest();

  expect([
    ctx.readPixels([4, 5], [4, 5, 6, 7, 8]),
    ctx.readPixels([3], [4, 5, 6, 7, 8]),
    ctx.readPixels([0, 7, 13], [17, 18]),
    ctx.readPixels([0, 7, 13], [16, 19]),
  ]).toStrictEqual([
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0],
    [1, 1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0, 0],
  ]);
});

test('#buildOutlineCoverage part-covers a pixel at the corner of a bowl', () => {
  const ctx = setupTest();
  const [corner] = ctx.readPixels([5], [1]);

  expect(corner).toBeGreaterThan(0);
  expect(corner).toBeLessThan(1);
});

test('#buildOutlineCoverage leaves the opening of the c and the inside of its bowl empty', () => {
  const ctx = setupTest();

  expect([
    ctx.readPixels([8, 9], [34, 35]),
    ctx.readPixels([6, 7, 8, 9, 10, 11], [28, 29, 30]),
  ]).toStrictEqual([[0, 0, 0, 0], Array.from({ length: 18 }, () => 0)]);
});
