import type { Colour, RGB } from '../compositor/types';
import { MUTED } from './constants';

export function toRGB(colour: Colour): RGB {
  return colour.kind === 'rgb' ? colour : MUTED;
}
