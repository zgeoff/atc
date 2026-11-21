import type { Colour } from '../compositor/types';

const PALETTE: readonly (readonly [number, number, number])[] = [
  [0xe0, 0x6c, 0x75],
  [0xe5, 0xc0, 0x7b],
  [0x98, 0xc3, 0x79],
  [0x56, 0xb6, 0xc2],
  [0x61, 0xaf, 0xef],
  [0xc6, 0x78, 0xdd],
  [0xff, 0x9e, 0x64],
  [0x73, 0xda, 0xca],
  [0xbb, 0x9a, 0xf7],
  [0xf7, 0x76, 0x8e],
  [0x9e, 0xce, 0x6a],
  [0x7d, 0xcf, 0xff],
];

const GREY: readonly [number, number, number] = [0x6e, 0x76, 0x81];

// The colour of a place, from its key alone, so it holds on every daemon and in every run.
export function pickPlaceColour(key: string): Colour {
  const [red, green, blue] = PALETTE[hashKey(key) % PALETTE.length] ?? GREY;

  return {
    kind: 'rgb',
    red: mixToward(red, GREY[0]),
    green: mixToward(green, GREY[1]),
    blue: mixToward(blue, GREY[2]),
  };
}

// FNV-1a, 32 bits
function hashKey(key: string): number {
  let hash = 0x81_1c_9d_c5;

  for (const char of key) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01_00_01_93) >>> 0;
  }

  return hash;
}

// how far each palette colour moves toward the grey
const DESATURATION = 0.2;

function mixToward(channel: number, target: number): number {
  return Math.round(channel + (target - channel) * DESATURATION);
}
