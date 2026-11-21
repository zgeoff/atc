import { splitGraphemes } from '../terminal/split-graphemes';

// The text cut to `width` terminal columns, with `…` in the last column of a cut text, and padded
// with spaces to `width` when `isPadded` is set. A control character becomes a space.
export function fitText(text: string, width: number, isPadded = false): string {
  if (width <= 0) {
    return '';
  }

  // oxlint-disable-next-line no-control-regex -- a control byte would break the panel's cells
  const graphemes = splitGraphemes(text.replaceAll(/[\u0000-\u001F\u007F]+/gu, ' '));
  const total = graphemes.reduce((sum, grapheme) => sum + grapheme.width, 0);
  let fitted = '';
  let used = 0;

  if (total <= width) {
    fitted = graphemes.map((grapheme) => grapheme.text).join('');
    used = total;
  } else {
    for (const grapheme of graphemes) {
      if (used + grapheme.width > width - 1) {
        break;
      }

      fitted += grapheme.text;
      used += grapheme.width;
    }

    fitted += '…';
    used += 1;
  }

  return isPadded ? `${fitted}${' '.repeat(Math.max(0, width - used))}` : fitted;
}
