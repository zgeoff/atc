import { toPaletteRGB } from './to-palette-rgb';
import type { Colour, RGB } from './types';

// The RGB of a colour, with a default colour taken as the fallback.
export function resolveColour(colour: Colour, fallback: RGB): RGB {
  if (colour.kind === 'default') {
    return fallback;
  }

  return colour.kind === 'palette' ? toPaletteRGB(colour.index) : colour;
}
