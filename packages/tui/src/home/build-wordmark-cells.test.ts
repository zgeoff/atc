import { expect, test } from 'bun:test';
import { buildBitmapCoverage } from './build-bitmap-coverage';
import { buildOutlineCoverage } from './build-outline-coverage';
import { buildWordmarkCells } from './build-wordmark-cells';
import { OUTLINE_SIZES } from './constants';
import type { Coverage } from './types';

function setupTest() {
  const background = { red: 0, green: 0, blue: 0 };

  // the colour one pixel shows once drawn: the top pixel of a cell is the `▀` foreground, and the
  // bottom pixel is the `▄` foreground or the `▀` background
  const drawPixel = (coverage: Coverage, row: number, col: number) => {
    const cell = buildWordmarkCells(coverage, background, 'truecolor')[Math.floor(row / 2)]?.[col];

    if (row % 2 === 0) {
      return cell?.ch === '▀' ? cell.fg : null;
    }

    return cell?.ch === '▄' ? cell.fg : (cell?.bg ?? null);
  };

  return { background, drawPixel };
}

test('#buildWordmarkCells draws a top pixel as an upper half, a bottom pixel as a lower half and both over a background', () => {
  const ctx = setupTest();

  const cells = buildWordmarkCells(
    [
      [1, 0, 1, 0],
      [0, 1, 1, 0],
    ],
    ctx.background,
    'truecolor',
  );

  expect(cells[0]?.map((cell) => [cell.ch, cell.fg !== null, cell.bg !== null])).toStrictEqual([
    ['▀', true, false],
    ['▄', true, false],
    ['▀', true, true],
    [' ', false, false],
  ]);
});

test('#buildWordmarkCells runs the colour from the top colour to the base colour', () => {
  const ctx = setupTest();
  const cells = buildWordmarkCells([[1], [1], [1], [1]], ctx.background, 'truecolor');

  expect([cells[0]?.[0]?.fg, cells[1]?.[0]?.bg]).toStrictEqual([
    { red: 0xee, green: 0xf1, blue: 0xf8 },
    { red: 0xc4, green: 0xcd, blue: 0xe4 },
  ]);
});

test.each([
  ['s10', () => buildOutlineCoverage(OUTLINE_SIZES.s10)],
  ['xs8', () => buildOutlineCoverage(OUTLINE_SIZES.xs8)],
  ['bitmap', () => buildBitmapCoverage()],
])(
  '#buildWordmarkCells starts the %s wordmark at the top colour and ends it at the base colour',
  (_size, buildCoverage) => {
    const ctx = setupTest();
    const coverage = buildCoverage();
    const firstRow = coverage.findIndex((row) => row.includes(1));
    const lastRow = coverage.findLastIndex((row) => row.includes(1));

    expect([
      ctx.drawPixel(coverage, firstRow, coverage[firstRow]?.indexOf(1) ?? -1),
      ctx.drawPixel(coverage, lastRow, coverage[lastRow]?.indexOf(1) ?? -1),
    ]).toStrictEqual([
      { red: 0xee, green: 0xf1, blue: 0xf8 },
      { red: 0xc4, green: 0xcd, blue: 0xe4 },
    ]);
  },
);

test('#buildWordmarkCells blends a part-covered pixel toward the background', () => {
  const cells = buildWordmarkCells([[0.5], [0]], { red: 0, green: 0, blue: 100 }, 'truecolor');

  expect(cells[0]?.[0]?.fg).toStrictEqual({ red: 119, green: 121, blue: 174 });
});

test('#buildWordmarkCells leaves off a faint pixel that 16 colours would show as black', () => {
  const ctx = setupTest();
  const cells = buildWordmarkCells([[0.05], [1]], ctx.background, '16');

  expect(cells[0]?.[0]).toStrictEqual({
    ch: '▄',
    fg: { red: 0xc4, green: 0xcd, blue: 0xe4 },
    bg: null,
  });
});
