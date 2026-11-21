import { expect, test } from 'bun:test';
import { pickColourDepth } from './pick-colour-depth';
import type { ColourDepth } from './types';

test.each<{ colorterm: string | undefined; term: string | undefined; expected: ColourDepth }>([
  { colorterm: 'truecolor', term: 'xterm', expected: 'truecolor' },
  { colorterm: '24bit', term: undefined, expected: 'truecolor' },
  { colorterm: undefined, term: 'xterm-256color', expected: '256' },
  { colorterm: 'yes', term: 'screen-256color', expected: '256' },
  { colorterm: undefined, term: 'xterm', expected: '16' },
  { colorterm: undefined, term: undefined, expected: '16' },
])('#pickColourDepth gives $expected for COLORTERM $colorterm and TERM $term', (row) => {
  expect(pickColourDepth({ colorterm: row.colorterm, term: row.term })).toBe(row.expected);
});
