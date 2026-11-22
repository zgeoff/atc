import { splitGraphemes } from '../terminal/split-graphemes';

// The graphemes, from `start` up to but not including `end`, whose lowercase holds the first match
// of `needle`. A letter's lowercase can be longer than the letter, as `İ` is.
export function findMatchedGraphemes(
  name: string,
  needle: string,
): { readonly start: number; readonly end: number } | null {
  const lowered = splitGraphemes(name).map((grapheme) => grapheme.text.toLowerCase());
  const at = lowered.join('').indexOf(needle);

  if (at === -1) {
    return null;
  }

  let offset = 0;
  let start = -1;

  for (const [index, text] of lowered.entries()) {
    const next = offset + text.length;

    if (start === -1 && at < next) {
      start = index;
    }

    if (at + needle.length <= next) {
      return { start, end: index + 1 };
    }

    offset = next;
  }

  return null;
}
