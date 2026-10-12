import type { TerminalInputModes } from '@atc/plugin-api/agent-adapter';
import { buildUnmarkedText } from '@atc/plugin-api/harness/build-unmarked-text';
import { findSlashCommand } from '@atc/plugin-api/harness/find-slash-command';
import { PASTE_MARKERS } from '@atc/plugin-api/harness/paste-markers';
import { planPastedLineInput } from '@atc/plugin-api/harness/plan-pasted-line-input';

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
