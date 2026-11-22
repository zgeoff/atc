import { measureWidth } from '../terminal/measure-width';
import { splitGraphemes } from '../terminal/split-graphemes';
import { findMatchedGraphemes } from './find-matched-graphemes';
import { fitText } from './fit-text';
import type { NameJump } from './types';

// The name cut to `width` columns and padded. While jump mode matches the name, the cut keeps the
// matched letters and the label after them in view, and drops the start of the name for an `…`
// when it must.
export function fitNameAroundMatch(name: string, width: number, jump: NameJump): string {
  const range = jump.typed === '' ? null : findMatchedGraphemes(name, jump.typed.toLowerCase());

  if (range === null) {
    return fitText(name, width, true);
  }

  const graphemes = splitGraphemes(name).map((grapheme) => grapheme.text);
  const labelLength = jump.label?.length ?? 0;
  const keptEnd = range.end + labelLength;
  const shownEnd = Math.min(keptEnd, graphemes.length);
  const overhang = keptEnd - shownEnd;
  const cutsEnd = shownEnd < graphemes.length ? 1 : 0;

  const needs = (start: number): number =>
    (start === 0 ? 0 : 1) +
    measureWidth(graphemes.slice(start, shownEnd).join('')) +
    overhang +
    cutsEnd;

  let start = 0;

  while (start < range.start && needs(start) > width) {
    start += 1;
  }

  const shown = graphemes.slice(start).join('');
  const text = start === 0 ? shown : `…${shown}`;

  return fitText(text, width, true);
}
