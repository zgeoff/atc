/**
 * The control bytes and escape sequences tests type into a terminal, by
 * name, so a test reads `KEYS.esc` where it would otherwise hold an opaque
 * escape. `bel` is the one entry a terminal writes rather than reads: the
 * byte that ends an OSC sequence on screen.
 */
export const KEYS = Object.freeze({
  ctrlSpace: '\u0000',
  ctrlA: '\u0001',
  ctrlB: '\u0002',
  ctrlC: '\u0003',
  bel: '\u0007',
  tab: '\u0009',
  ctrlJ: '\u000A',
  enter: '\u000D',
  ctrlU: '\u0015',
  esc: '\u001B',
  ctrlRightBracket: '\u001D',
  backspace: '\u007F',
  up: '\u001B[A',
  down: '\u001B[B',
  right: '\u001B[C',
  left: '\u001B[D',
  pasteOpen: '\u001B[200~',
  pasteClose: '\u001B[201~',
});
