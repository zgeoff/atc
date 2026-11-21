import type { RGB } from './types';

const STANDARD_16: readonly RGB[] = [
  { red: 0, green: 0, blue: 0 },
  { red: 205, green: 0, blue: 0 },
  { red: 0, green: 205, blue: 0 },
  { red: 205, green: 205, blue: 0 },
  { red: 0, green: 0, blue: 238 },
  { red: 205, green: 0, blue: 205 },
  { red: 0, green: 205, blue: 205 },
  { red: 229, green: 229, blue: 229 },
  { red: 127, green: 127, blue: 127 },
  { red: 255, green: 0, blue: 0 },
  { red: 0, green: 255, blue: 0 },
  { red: 255, green: 255, blue: 0 },
  { red: 92, green: 92, blue: 255 },
  { red: 255, green: 0, blue: 255 },
  { red: 0, green: 255, blue: 255 },
  { red: 255, green: 255, blue: 255 },
];

const CUBE_LEVELS: readonly number[] = [0, 95, 135, 175, 215, 255];

export function toPaletteRGB(index: number): RGB {
  if (index < 16) {
    return STANDARD_16[Math.max(0, index)] ?? { red: 0, green: 0, blue: 0 };
  }

  if (index < 232) {
    const offset = index - 16;

    return {
      red: CUBE_LEVELS[Math.floor(offset / 36)] ?? 0,
      green: CUBE_LEVELS[Math.floor(offset / 6) % 6] ?? 0,
      blue: CUBE_LEVELS[offset % 6] ?? 0,
    };
  }

  const grey = 8 + (Math.min(index, 255) - 232) * 10;

  return { red: grey, green: grey, blue: grey };
}
