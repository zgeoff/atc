import { blendRGB } from './blend-rgb';
import { resolveColour } from './resolve-colour';
import { toRGBColour } from './to-rgb-colour';
import type { Colour, TerminalFacts } from './types';

// Blends a background toward the terminal's own by a share from 0 to 1, and gives the terminal's
// own default once the share is whole.
export function fadeBackground(colour: Colour, terminal: TerminalFacts, share: number): Colour {
  // The terminal's background is a guess until the terminal answers the colour query, and some
  // never answer. A default kept as default shows the real colour; the guess would paint a block.
  if (colour.kind === 'default' || share >= 1) {
    return { kind: 'default' };
  }

  return toRGBColour(
    blendRGB(resolveColour(colour, terminal.background), terminal.background, share),
  );
}
