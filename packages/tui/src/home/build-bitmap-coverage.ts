import { BITMAP_WORDMARK } from './constants';
import { padToEvenRows } from './pad-to-even-rows';
import type { Coverage } from './types';

// The hand-drawn wordmark: each pixel is fully on or fully off.
export function buildBitmapCoverage(): Coverage {
  return padToEvenRows(
    BITMAP_WORDMARK.map((line) => Array.from(line, (pixel) => (pixel === '#' ? 1 : 0))),
  );
}
