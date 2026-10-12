/**
 * The bracketed paste markers a terminal wraps around pasted text once the
 * TUI in it has turned bracketed paste on.
 */
export const PASTE_MARKERS = {
  start: '\u001B[200~',
  end: '\u001B[201~',
} as const;
