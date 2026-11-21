import type { RGB } from '../compositor/types';
import type { OutlineSize } from './types';

export const OUTLINE_SIZES = {
  s10: {
    stroke: 2,
    xHeight: 10,
    radius: 4,
    aWidth: 13,
    cWidth: 13,
    ascender: 4,
    tWidth: 6,
    tStem: 2,
    gap: 2,
    track: 2,
  },
  xs8: {
    stroke: 2,
    xHeight: 8,
    radius: 3,
    aWidth: 10,
    cWidth: 10,
    ascender: 3,
    tWidth: 6,
    tStem: 2,
    gap: 2,
    track: 2,
  },
} satisfies Record<string, OutlineSize>;

// '#' is on and '.' is off. No pixel is part-covered.
export const BITMAP_WORDMARK: readonly string[] = [
  '..........#..........',
  '..........#..........',
  '.#####..#####..#####.',
  '#....#....#...#......',
  '#....#....#...#......',
  '#....#....#...#......',
  '.#####....#....#####.',
];

// samples per pixel along each axis, when a curve's coverage is worked out
export const SUPERSAMPLES = 6;
export const WORDMARK_TOP: RGB = { red: 0xee, green: 0xf1, blue: 0xf8 };
export const WORDMARK_BASE: RGB = { red: 0xc4, green: 0xcd, blue: 0xe4 };
export const AMBER: RGB = { red: 0xf0, green: 0xb4, blue: 0x5a };
export const KEY_BLUE: RGB = { red: 0x7a, green: 0xa2, blue: 0xf7 };
