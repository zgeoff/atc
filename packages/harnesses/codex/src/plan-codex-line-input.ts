import type { LineInputStep, TerminalInputModes } from '@atc/plugin-api';
import {
  PASTE_MARKERS,
  buildUnmarkedText,
  findSlashCommand,
  planPastedLineInput,
} from '@atc/plugin-api';

const COMMAND_NAME_PAUSE_MS = 100;

// codex collapses a paste over 1,000 chars into a placeholder, so a long slash command
// would be sent as a message. The name goes first on its own because codex reads 1,024
// bytes at a time and stops after a read that completes an input event.
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
