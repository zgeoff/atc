import type { TerminalInputModes } from './agent-adapter';
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

  return [command.typed, `${PASTE_START}${command.argument}${PASTE_END}`, '\r'];
}

// A slash, a command name that may hold a plugin namespace, at least one
// space, then the argument. A path such as `/tmp/out` has a slash after its
// first name, so it never matches.
const SLASH_COMMAND = /^(?<typed>\/[A-Za-z0-9][\w:-]* +)(?<argument>.+)$/su;

function findSlashCommand(text: string): { typed: string; argument: string } | null {
  const groups = SLASH_COMMAND.exec(text)?.groups;
  const typed = groups?.['typed'];
  const argument = groups?.['argument'];

  // An argument of spaces alone leaves a bare command, which the line
  // pastes whole like any short line.
  if (typed === undefined || argument === undefined || argument.trim() === '') {
    return null;
  }

  return { typed, argument };
}
