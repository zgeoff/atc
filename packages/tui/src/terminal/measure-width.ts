import { splitGraphemes } from './split-graphemes';

export function measureWidth(text: string): number {
  return splitGraphemes(text).reduce((total, grapheme) => total + grapheme.width, 0);
}
