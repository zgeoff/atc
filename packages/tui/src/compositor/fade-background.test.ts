import { expect, test } from 'bun:test';
import { fadeBackground } from './fade-background';
import type { Colour, TerminalFacts } from './types';

test.each<{ name: string; colour: Colour; share: number; expected: Colour }>([
  {
    name: 'keeps a default background default partway through',
    colour: { kind: 'default' },
    share: 0.5,
    expected: { kind: 'default' },
  },
  {
    name: 'keeps a default background default at no share',
    colour: { kind: 'default' },
    share: 0,
    expected: { kind: 'default' },
  },
  {
    name: 'blends an explicit background toward the terminal background',
    colour: { kind: 'rgb', red: 100, green: 0, blue: 200 },
    share: 0.5,
    expected: { kind: 'rgb', red: 50, green: 0, blue: 100 },
  },
  {
    name: 'gives the default background once the share is whole',
    colour: { kind: 'rgb', red: 100, green: 0, blue: 200 },
    share: 1,
    expected: { kind: 'default' },
  },
])('#fadeBackground $name', (row) => {
  const terminal: TerminalFacts = {
    depth: 'truecolor',
    background: { red: 0, green: 0, blue: 0 },
    foreground: { red: 255, green: 255, blue: 255 },
    kittyKeyboard: false,
  };

  expect(fadeBackground(row.colour, terminal, row.share)).toStrictEqual(row.expected);
});
