import type { TerminalInputModes } from '@atc/plugin-api';
import {
  PASTE_MARKERS,
  buildUnmarkedText,
  findSlashCommand,
  planPastedLineInput,
} from '@atc/plugin-api';

export function planClaudeLineInput(text: string, modes: TerminalInputModes): readonly string[] {
  const unmarked = buildUnmarkedText(text);
  const command = modes.bracketedPaste ? findSlashCommand(unmarked) : null;

  if (command === null) {
    return planPastedLineInput(text, modes);
  }

  // Claude sends a long paste as a message, so the command name is typed as keys and only the
  // argument pasted, which runs the command at any argument length
  return [command.name, `${PASTE_MARKERS.start}${command.argument}${PASTE_MARKERS.end}`, '\r'];
}
