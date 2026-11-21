import { eastAsianWidth } from 'get-east-asian-width';

export interface Grapheme {
  readonly text: string;

  // the terminal columns it takes: 0, 1 or 2
  readonly width: number;
}

const segmenter = new Intl.Segmenter();

export function splitGraphemes(text: string): readonly Grapheme[] {
  return Array.from(segmenter.segment(text), (part) => ({
    text: part.segment,
    width: measureGrapheme(part.segment),
  }));
}

const EMOJI_PRESENTATION = '\u{FE0F}';

function measureGrapheme(grapheme: string): number {
  const first = grapheme.codePointAt(0);

  if (first === undefined) {
    return 0;
  }

  if (grapheme.includes(EMOJI_PRESENTATION)) {
    return 2;
  }

  return isZeroWidth(first) ? 0 : eastAsianWidth(first);
}

function isZeroWidth(codePoint: number): boolean {
  return codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0);
}
