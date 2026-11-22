import type { Colour, RGB } from './types';

export function toRGBColour(rgb: RGB): Colour {
  return { kind: 'rgb', red: rgb.red, green: rgb.green, blue: rgb.blue };
}
