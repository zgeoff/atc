import { expect, test } from 'bun:test';
import { quantiseColour } from './quantise-colour';
import type { Colour, ColourDepth } from './types';

test.each<{ name: string; colour: Colour; depth: ColourDepth; expected: Colour }>([
  {
    name: 'a truecolor colour at truecolor',
    colour: { kind: 'rgb', red: 12, green: 34, blue: 56 },
    depth: 'truecolor',
    expected: { kind: 'rgb', red: 12, green: 34, blue: 56 },
  },
  {
    name: 'default at 16',
    colour: { kind: 'default' },
    depth: '16',
    expected: { kind: 'default' },
  },
  {
    name: 'a palette index inside 256',
    colour: { kind: 'palette', index: 200 },
    depth: '256',
    expected: { kind: 'palette', index: 200 },
  },
  {
    name: 'a palette index inside 16',
    colour: { kind: 'palette', index: 9 },
    depth: '16',
    expected: { kind: 'palette', index: 9 },
  },
  {
    name: 'pure red at 256 to the bright red of the low palette',
    colour: { kind: 'rgb', red: 255, green: 0, blue: 0 },
    depth: '256',
    expected: { kind: 'palette', index: 9 },
  },
  {
    name: 'a cube colour at 256 to its cube index',
    colour: { kind: 'rgb', red: 95, green: 135, blue: 175 },
    depth: '256',
    expected: { kind: 'palette', index: 67 },
  },
  {
    name: 'a grey at 256 to the grey ramp',
    colour: { kind: 'rgb', red: 118, green: 118, blue: 118 },
    depth: '256',
    expected: { kind: 'palette', index: 243 },
  },
  {
    name: 'dark blue at 16',
    colour: { kind: 'rgb', red: 0, green: 0, blue: 200 },
    depth: '16',
    expected: { kind: 'palette', index: 4 },
  },
  {
    name: 'a cube index at 16 to the nearest low colour',
    colour: { kind: 'palette', index: 196 },
    depth: '16',
    expected: { kind: 'palette', index: 9 },
  },
])('#quantiseColour maps $name', (row) => {
  expect(quantiseColour(row.colour, row.depth)).toStrictEqual(row.expected);
});
