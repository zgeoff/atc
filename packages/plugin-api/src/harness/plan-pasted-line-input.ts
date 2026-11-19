import type { TerminalInputModes } from '../agent-adapter';
import { buildUnmarkedText } from './build-unmarked-text';
import { PASTE_MARKERS } from './paste-markers';

// A TUI that tells paste from typing treats a newline inside a burst as text.
// Send the line as a paste and the carriage return as its own write: after a closing
// paste marker it is a separate Enter however the writes arrive.
export function planPastedLineInput(text: string, modes: TerminalInputModes): readonly string[] {
  if (text === '') {
    return ['\r'];
  }

  const unmarked = buildUnmarkedText(text);

  return modes.bracketedPaste
    ? [`${PASTE_MARKERS.start}${unmarked}${PASTE_MARKERS.end}`, '\r']
    : [unmarked, '\r'];
}
