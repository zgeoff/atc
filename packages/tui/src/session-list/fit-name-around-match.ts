import { measureWidth } from '../terminal/measure-width';
import { splitGraphemes } from '../terminal/split-graphemes';
import { findMatchedGraphemes } from './find-matched-graphemes';
import { fitText } from './fit-text';
import type { NameJump } from './types';

export interface FittedName {
  // the name cut to the width and padded
  readonly text: string;

  // the graphemes of `text` that show matched letters, from `start` up to but not including `end`
  readonly match: { readonly start: number; readonly end: number } | null;
}

// The name cut to `width` columns and padded. While jump mode matches the name, the cut keeps the
// end of the match and the label after it in view. It drops the start of the name for an `…`, and
// then the start of the match when the match and label are too long for the width.
export function fitNameAroundMatch(name: string, width: number, jump: NameJump): FittedName {
  const range = jump.typed === '' ? null : findMatchedGraphemes(name, jump.typed);

  if (range === null) {
    return { text: fitText(name, width, true), match: null };
  }

  const graphemes = splitGraphemes(name).map((grapheme) => grapheme.text);
  const labelLength = jump.label?.length ?? 0;
  const labelEnd = Math.min(range.end + labelLength, graphemes.length);
  const overhang = range.end + labelLength - labelEnd;
  const cutsEnd = labelEnd < graphemes.length ? 1 : 0;

  const needs = (start: number): number =>
    (start === 0 ? 0 : 1) +
    Math.min(
      measureWidth(graphemes.slice(start).join('')),
      measureWidth(graphemes.slice(start, labelEnd).join('')) + cutsEnd,
    ) +
    overhang;

  let start = 0;

  while (start < range.end && needs(start) > width) {
    start += 1;
  }

  const lead = start === 0 ? 0 : 1;
  const shown = `${lead === 0 ? '' : '…'}${graphemes.slice(start).join('')}`;

  return {
    text: fitText(shown, width, true),
    match: { start: Math.max(range.start, start) - start + lead, end: range.end - start + lead },
  };
}
