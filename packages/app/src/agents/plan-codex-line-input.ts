import type { LineInputStep, TerminalInputModes } from './agent-adapter';
import { buildUnmarkedText } from './build-unmarked-text';
import { findSlashCommand } from './find-slash-command';
import { PASTE_MARKERS } from './paste-markers';
import { planPastedLineInput } from './plan-pasted-line-input';

// Long enough for Codex to read the command name between frames of a busy
// session, short enough that input held behind the line waits unnoticed.
const COMMAND_NAME_PAUSE_MS = 100;

/**
 * Pastes a line into the Codex TUI and submits it, as the pasted line
 * planner does, except for a line that opens with a slash command and an
 * argument. Codex shows a paste of more than 1,000 characters as a
 * placeholder, so a long slash command pasted whole no longer opens with its
 * name and goes out as a message. Such a line instead goes out as the
 * command name and the spaces after it in one paste, a pause, the argument
 * in a second paste, and one carriage return.
 *
 * The pause is there because Codex reads its terminal 1,024 bytes at a
 * time and stops reading after a read that completes an input event, until
 * new input arrives. Sent at once, the name and a long argument would fill
 * one read with the name's event and part of the argument, and the rest of
 * the line would wait for the next key. The pause lets Codex read the name
 * on its own first. A TUI that has not turned bracketed paste on gets every
 * line as the pasted line planner writes it.
 */
export function planCodexLineInput(
  text: string,
  modes: TerminalInputModes,
): readonly LineInputStep[] {
  const unmarked = buildUnmarkedText(text);
  const command = modes.bracketedPaste ? findSlashCommand(unmarked) : null;

  if (command === null) {
    return planPastedLineInput(text, modes);
  }

  return [
    `${PASTE_MARKERS.start}${command.name}${PASTE_MARKERS.end}`,
    { pauseMs: COMMAND_NAME_PAUSE_MS },
    `${PASTE_MARKERS.start}${command.argument}${PASTE_MARKERS.end}`,
    '\r',
  ];
}
