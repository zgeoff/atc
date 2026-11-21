import type { RGB } from './types';

// The colour a share from 0 to 1 of the way from one colour toward another.
export function blendRGB(from: RGB, toward: RGB, share: number): RGB {
  return {
    red: Math.round(from.red + (toward.red - from.red) * share),
    green: Math.round(from.green + (toward.green - from.green) * share),
    blue: Math.round(from.blue + (toward.blue - from.blue) * share),
  };
}
