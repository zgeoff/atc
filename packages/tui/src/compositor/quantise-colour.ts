import { toPaletteRGB } from './to-palette-rgb';
import type { Colour, ColourDepth, RGB } from './types';

const LOW_16 = Array.from({ length: 16 }, (_, index) => index);
const HIGH_240 = Array.from({ length: 240 }, (_, index) => index + 16);

// The nearest colour the depth can show. An index below the depth passes through as the agent
// sent it.
export function quantiseColour(colour: Colour, depth: ColourDepth): Colour {
  if (depth === 'truecolor' || colour.kind === 'default') {
    return colour;
  }

  const limit = depth === '256' ? 256 : 16;

  if (colour.kind === 'palette' && colour.index < limit) {
    return colour;
  }

  const target = colour.kind === 'palette' ? toPaletteRGB(colour.index) : colour;
  const candidates = depth === '256' ? [...LOW_16, ...HIGH_240] : LOW_16;

  return { kind: 'palette', index: pickNearestIndex(target, candidates) };
}

function pickNearestIndex(target: RGB, candidates: readonly number[]): number {
  let best = candidates[0] ?? 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const index of candidates) {
    const distance = measureDistance(target, toPaletteRGB(index));

    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }

  return best;
}

function measureDistance(left: RGB, right: RGB): number {
  return (
    (left.red - right.red) ** 2 + (left.green - right.green) ** 2 + (left.blue - right.blue) ** 2
  );
}
