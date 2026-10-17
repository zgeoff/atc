import type { LineInputStep, TerminalInputModes } from '@atc/plugin-api';
import {
  PASTE_MARKERS,
  buildUnmarkedText,
  findSlashCommand,
  planPastedLineInput,
} from '@atc/plugin-api';

// Long enough for Codex to read the command name between frames of a busy
// session, short enough that input held behind the line waits unnoticed.
const COMMAND_NAME_PAUSE_MS = 100;

// codex shows a paste over 1,000 chars as a placeholder, so a long slash command pasted whole
// would go out as a message; the name goes alone first because codex reads 1,024 bytes at a
// time and stops reading after a read that completes an input event
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
