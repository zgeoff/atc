import { expect, test } from 'bun:test';
import { BLANK_CELL } from './blank-cell';
import { buildCellBuffer } from './build-cell-buffer';
import { renderFrameDiff } from './render-frame-diff';
import type { Cell, ColourDepth } from './types';

function setupTest() {
  return {
    buildBuffer: (lines: readonly string[], style: Partial<Cell> = {}) => {
      const buffer = buildCellBuffer(12, lines.length);

      for (const [row, line] of lines.entries()) {
        for (const [col, ch] of [...line].entries()) {
          buffer.set(col, row, { ...BLANK_CELL, ch, ...style });
        }
      }

      return buffer;
    },
  };
}

test.each<{ name: string; before: string[]; after: string[]; expected: string }>([
  { name: 'nothing for equal buffers', before: ['hello'], after: ['hello'], expected: '' },
  {
    name: 'one changed cell with a move and a reset around it',
    before: ['hello'],
    after: ['hallo'],
    expected: '\u001B[1;2H\u001B[0ma\u001B[0m',
  },
  {
    name: 'one move for adjacent changed cells',
    before: ['hello'],
    after: ['jello'],
    expected: '\u001B[1;1H\u001B[0mj\u001B[0m',
  },
  {
    name: 'a short gap written over in the run',
    before: ['a    b'],
    after: ['x    y'],
    expected: '\u001B[1;1H\u001B[0mx    y\u001B[0m',
  },
  {
    name: 'a move across a long gap',
    before: ['a        b'],
    after: ['x        y'],
    expected: '\u001B[1;1H\u001B[0mx\u001B[1;10Hy\u001B[0m',
  },
  {
    name: 'a move for each changed row',
    before: ['ab', 'cd'],
    after: ['ab', 'xd'],
    expected: '\u001B[2;1H\u001B[0mx\u001B[0m',
  },
])('#renderFrameDiff writes $name', (row) => {
  const ctx = setupTest();

  expect(
    renderFrameDiff(ctx.buildBuffer(row.before), ctx.buildBuffer(row.after), 'truecolor'),
  ).toBe(row.expected);
});

test.each<{ name: string; depth: ColourDepth; style: Partial<Cell>; params: string }>([
  { name: 'bold', depth: 'truecolor', style: { bold: true }, params: '0;1' },
  {
    name: 'italic and strikethrough',
    depth: 'truecolor',
    style: { italic: true, strikethrough: true },
    params: '0;3;9',
  },
  { name: 'curly underline', depth: 'truecolor', style: { underline: 'curly' }, params: '0;4:3' },
  { name: 'double underline', depth: 'truecolor', style: { underline: 'double' }, params: '0;21' },
  {
    name: 'inverse and dim',
    depth: 'truecolor',
    style: { inverse: true, dim: true },
    params: '0;2;7',
  },
  {
    name: 'a low palette foreground',
    depth: '16',
    style: { fg: { kind: 'palette', index: 1 } },
    params: '0;31',
  },
  {
    name: 'a bright palette background',
    depth: '16',
    style: { bg: { kind: 'palette', index: 12 } },
    params: '0;104',
  },
  {
    name: 'a 256 palette foreground',
    depth: '256',
    style: { fg: { kind: 'palette', index: 200 } },
    params: '0;38;5;200',
  },
  {
    name: 'a truecolor foreground',
    depth: 'truecolor',
    style: { fg: { kind: 'rgb', red: 1, green: 2, blue: 3 } },
    params: '0;38;2;1;2;3',
  },
  {
    name: 'a truecolor background at 256 colours',
    depth: '256',
    style: { bg: { kind: 'rgb', red: 255, green: 0, blue: 0 } },
    params: '0;101',
  },
])('#renderFrameDiff writes the attributes $name at depth $depth', (row) => {
  const ctx = setupTest();

  expect(
    renderFrameDiff(ctx.buildBuffer(['.']), ctx.buildBuffer(['x'], row.style), row.depth),
  ).toBe(`\u001B[1;1H\u001B[${row.params}mx\u001B[0m`);
});

test('#renderFrameDiff opens a link around a run and closes it after', () => {
  const ctx = setupTest();

  expect(
    renderFrameDiff(
      ctx.buildBuffer(['ab']),
      ctx.buildBuffer(['ab'], { link: 'https://example.test' }),
      'truecolor',
    ),
  ).toBe('\u001B[1;1H\u001B[0m\u001B]8;;https://example.test\u001B\\ab\u001B]8;;\u001B\\\u001B[0m');
});

test('#renderFrameDiff writes a wide character once and skips its second cell', () => {
  const buffer = buildCellBuffer(4, 1);

  buffer.set(0, 0, { ...BLANK_CELL, ch: '界' });
  buffer.set(1, 0, { ...BLANK_CELL, ch: '' });

  expect(renderFrameDiff(buildCellBuffer(4, 1), buffer, 'truecolor')).toBe(
    '\u001B[1;1H\u001B[0m界\u001B[0m',
  );
});

test('#renderFrameDiff redraws a wide character when only its second cell changed', () => {
  const before = buildCellBuffer(4, 1);
  const after = buildCellBuffer(4, 1);

  before.set(0, 0, { ...BLANK_CELL, ch: '界' });
  before.set(1, 0, { ...BLANK_CELL, ch: '' });
  after.set(0, 0, { ...BLANK_CELL, ch: 'a' });
  after.set(1, 0, { ...BLANK_CELL, ch: 'b' });

  expect(renderFrameDiff(before, after, 'truecolor')).toBe('\u001B[1;1H\u001B[0mab\u001B[0m');
});
