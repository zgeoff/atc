import { splitGraphemes } from '../terminal/split-graphemes';

// Each grapheme of the text with its case folded, so jump mode matches and draws on one text. Each
// grapheme folds alone: lowercasing a whole name turns a final `Σ` into `ς`, where alone it is `σ`.
// Upper then lower case folds `ς` and `σ` together; a folded grapheme can be longer, as `ß` is.
export function toFoldedGraphemes(text: string): string[] {
  return splitGraphemes(text).map((grapheme) => grapheme.text.toUpperCase().toLowerCase());
}
