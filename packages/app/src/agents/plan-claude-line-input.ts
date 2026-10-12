import type { TerminalInputModes } from './agent-adapter';
import { findSlashCommand } from './find-slash-command';
import { planPastedLineInput } from './plan-pasted-line-input';

const PASTE_START = '\u001B[200~';
const PASTE_END = '\u001B[201~';

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
  const unmarked = text.replaceAll(PASTE_START, '').replaceAll(PASTE_END, '');
  const command = modes.bracketedPaste ? findSlashCommand(unmarked) : null;

  if (command === null) {
    return planPastedLineInput(text, modes);
  }

  return [command.name, `${PASTE_START}${command.argument}${PASTE_END}`, '\r'];
}
