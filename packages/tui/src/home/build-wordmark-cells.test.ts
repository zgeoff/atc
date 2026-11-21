import { expect, test } from 'bun:test';
import { buildWordmarkCells } from './build-wordmark-cells';

function setupTest() {
  return { background: { red: 0, green: 0, blue: 0 } };
}

test('#buildWordmarkCells draws a top pixel as an upper half, a bottom pixel as a lower half and both over a background', () => {
  const ctx = setupTest();

  const cells = buildWordmarkCells(
    [
      [1, 0, 1, 0],
      [0, 1, 1, 0],
    ],
    ctx.background,
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
  const cells = buildWordmarkCells([[1], [1], [1], [1]], ctx.background);

  expect([cells[0]?.[0]?.fg, cells[1]?.[0]?.bg]).toStrictEqual([
    { red: 0xee, green: 0xf1, blue: 0xf8 },
    { red: 0xc4, green: 0xcd, blue: 0xe4 },
  ]);
});

test('#buildWordmarkCells blends a part-covered pixel toward the background', () => {
  const cells = buildWordmarkCells([[0.5], [0]], { red: 0, green: 0, blue: 100 });

  expect(cells[0]?.[0]?.fg).toStrictEqual({ red: 119, green: 121, blue: 174 });
});
