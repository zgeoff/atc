import type { TerminalInputModes } from '@atc/plugin-api';
import {
  PASTE_MARKERS,
  buildUnmarkedText,
  findSlashCommand,
  planPastedLineInput,
} from '@atc/plugin-api';

/**
 * Pastes a line into the Claude TUI and submits it, as the pasted line
 * planner does, except for a line that opens with a slash command and an
 * argument. Claude takes a long paste as pasted text and sends it as a
 * message, so such a line has its command name and the spaces after it typed
 * as keys and only the argument pasted, then one carriage return. The
 * command then runs at any argument length. A TUI that has not turned
 * bracketed paste on gets every line as the pasted line planner writes it.
 */
export function planClaudeLineInput(text: string, modes: TerminalInputModes): readonly string[] {
  const unmarked = buildUnmarkedText(text);
  const command = modes.bracketedPaste ? findSlashCommand(unmarked) : null;

  if (command === null) {
    return planPastedLineInput(text, modes);
  }

  return [command.name, `${PASTE_MARKERS.start}${command.argument}${PASTE_MARKERS.end}`, '\r'];
}
