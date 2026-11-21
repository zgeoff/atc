import { expect, test } from 'bun:test';
import { BLANK_CELL } from './blank-cell';
import { dimCell } from './dim-cell';
import type { Cell, TerminalFacts } from './types';

test.each<{
  name: string;
  cell: Partial<Cell>;
  facts: Partial<TerminalFacts>;
  share: number;
  expected: Partial<Cell>;
}>([
  {
    name: 'a foreground toward the background, keeping a default background',
    cell: { fg: { kind: 'rgb', red: 200, green: 100, blue: 0 } },
    facts: { background: { red: 0, green: 0, blue: 0 } },
    share: 0.5,
    expected: { fg: { kind: 'rgb', red: 100, green: 50, blue: 0 } },
  },
  {
    name: 'a default foreground from the terminal facts',
    cell: {},
    facts: {
      foreground: { red: 100, green: 100, blue: 100 },
      background: { red: 0, green: 0, blue: 0 },
    },
    share: 0.5,
    expected: { fg: { kind: 'rgb', red: 50, green: 50, blue: 50 } },
  },
  {
    name: 'both colours of a cell with an explicit background',
    cell: {
      fg: { kind: 'rgb', red: 100, green: 100, blue: 100 },
      bg: { kind: 'rgb', red: 40, green: 40, blue: 40 },
    },
    facts: { background: { red: 0, green: 0, blue: 0 } },
    share: 0.5,
    expected: {
      fg: { kind: 'rgb', red: 50, green: 50, blue: 50 },
      bg: { kind: 'rgb', red: 20, green: 20, blue: 20 },
    },
  },
  {
    name: 'a palette colour through the standard palette',
    cell: { fg: { kind: 'palette', index: 15 } },
    facts: { background: { red: 0, green: 0, blue: 0 } },
    share: 0.5,
    expected: { fg: { kind: 'rgb', red: 128, green: 128, blue: 128 } },
  },
  {
    name: 'an inverse cell by swapping first, so the dim blends the swapped colours',
    cell: {
      inverse: true,
      fg: { kind: 'rgb', red: 200, green: 200, blue: 200 },
      bg: { kind: 'rgb', red: 100, green: 0, blue: 0 },
    },
    facts: { background: { red: 0, green: 0, blue: 0 } },
    share: 0.5,
    expected: {
      inverse: false,
      fg: { kind: 'rgb', red: 50, green: 0, blue: 0 },
      bg: { kind: 'rgb', red: 100, green: 100, blue: 100 },
    },
  },
  {
    name: 'an inverse cell of default colours into explicit colours',
    cell: { inverse: true },
    facts: {
      foreground: { red: 200, green: 200, blue: 200 },
      background: { red: 0, green: 0, blue: 0 },
    },
    share: 0.5,
    expected: {
      inverse: false,
      fg: { kind: 'rgb', red: 0, green: 0, blue: 0 },
      bg: { kind: 'rgb', red: 100, green: 100, blue: 100 },
    },
  },
  {
    name: 'a cell at 16 colours by keeping its colours and setting dim',
    cell: { fg: { kind: 'palette', index: 2 }, inverse: true },
    facts: { depth: '16' },
    share: 0.5,
    expected: { fg: { kind: 'palette', index: 2 }, inverse: true, dim: true },
  },
])('#dimCell dims $name', (row) => {
  const facts: TerminalFacts = {
    depth: 'truecolor',
    background: { red: 13, green: 17, blue: 23 },
    foreground: { red: 201, green: 209, blue: 217 },
    kittyKeyboard: false,
    ...row.facts,
  };

  expect(dimCell({ ...BLANK_CELL, ...row.cell }, facts, row.share)).toStrictEqual({
    ...BLANK_CELL,
    ...row.cell,
    ...row.expected,
  });
});
