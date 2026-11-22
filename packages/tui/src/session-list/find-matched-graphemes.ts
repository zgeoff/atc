import { toFoldedGraphemes } from './to-folded-graphemes';

// The graphemes, from `start` up to but not including `end`, whose folded text holds the first
// match of the folded `typed`, or null when the name does not match.
export function findMatchedGraphemes(
  name: string,
  typed: string,
): { readonly start: number; readonly end: number } | null {
  const folded = toFoldedGraphemes(name);
  const needle = toFoldedGraphemes(typed).join('');
  const at = folded.join('').indexOf(needle);

  if (at === -1 || needle === '') {
    return null;
  }

  let offset = 0;
  let start = -1;

  for (const [index, text] of folded.entries()) {
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
