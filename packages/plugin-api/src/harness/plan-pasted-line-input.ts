import type { TerminalInputModes } from '../agent-adapter';
import { buildUnmarkedText } from './build-unmarked-text';
import { PASTE_MARKERS } from './paste-markers';

// a TUI that tells a paste from typing takes a newline inside a burst as text,
// so the line goes as a paste and a carriage return as its own write, which
// after a closing paste marker is a separate Enter however the writes arrive.
export function planPastedLineInput(text: string, modes: TerminalInputModes): readonly string[] {
  // the carriage return alone submits what the composer holds.
  if (text === '') {
    return ['\r'];
  }

  const unmarked = buildUnmarkedText(text);

  return modes.bracketedPaste
    ? [`${PASTE_MARKERS.start}${unmarked}${PASTE_MARKERS.end}`, '\r']
    : [unmarked, '\r'];
}
