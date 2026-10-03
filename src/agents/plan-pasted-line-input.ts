import type { TerminalInputModes } from './agent-adapter';

const PASTE_START = '\u001B[200~';
const PASTE_END = '\u001B[201~';

/**
 * Pastes a line into a TUI that tells a paste from typing, then submits it
 * with a carriage return as its own write. Such a TUI takes a newline inside
 * a burst of input as part of the text, so a line typed with its newline
 * stays unsent in the composer. Between bracketed paste markers the whole
 * text is one paste event, newlines included, and the carriage return after
 * the closing marker is a separate Enter key event however the two writes
 * arrive. Paste markers inside the text are dropped, so the text can neither
 * end the paste early nor start one of its own. A TUI that has not turned
 * bracketed paste on gets the text unmarked, and may still read both writes
 * as one burst.
 */
export function planPastedLineInput(text: string, modes: TerminalInputModes): readonly string[] {
  const unmarked = text.replaceAll(PASTE_START, '').replaceAll(PASTE_END, '');

  return modes.bracketedPaste ? [`${PASTE_START}${unmarked}${PASTE_END}`, '\r'] : [unmarked, '\r'];
}
