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
 * as one burst. Empty text is the carriage return alone, which submits what
 * the composer holds and adds nothing to it.
 *
 * A line that opens with a slash command and an argument has the command
 * name and the spaces after it typed as keys, and only the argument pasted.
 * A TUI that collapses a long paste into a placeholder then still reads the
 * command, which it would otherwise take as pasted text and send as a
 * message.
 */
export function planPastedLineInput(text: string, modes: TerminalInputModes): readonly string[] {
  if (text === '') {
    return ['\r'];
  }

  const unmarked = text.replaceAll(PASTE_START, '').replaceAll(PASTE_END, '');

  if (!modes.bracketedPaste) {
    return [unmarked, '\r'];
  }

  const command = findSlashCommand(unmarked);

  if (command === null) {
    return [`${PASTE_START}${unmarked}${PASTE_END}`, '\r'];
  }

  return [command.typed, `${PASTE_START}${command.argument}${PASTE_END}`, '\r'];
}

// A slash, a command name that may hold a plugin namespace, at least one
// space, then the argument. A path such as `/tmp/out` has a slash after its
// first name, so it never matches.
const SLASH_COMMAND = /^(?<typed>\/[A-Za-z0-9][\w:-]* +)(?<argument>.+)$/su;

function findSlashCommand(text: string): { typed: string; argument: string } | null {
  const match = SLASH_COMMAND.exec(text);
  const [, typed = '', argument = ''] = match ?? [];

  // An argument of spaces alone leaves a bare command, which the line
  // pastes whole like any short line.
  if (argument.trim() === '') {
    return null;
  }

  return { typed, argument };
}
