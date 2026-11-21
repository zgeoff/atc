import { RESET_LEGACY_INPUT_MODES, ansi } from '@atc/core';

// The TUI sets the kitty flags and never pushes them, so it clears them with a set, and only on a
// terminal that answered the kitty query.
export function formatTerminalRestore(hasKittyKeyboard: boolean): string {
  const kitty = hasKittyKeyboard ? '\u001B[=0u' : '';

  return `${RESET_LEGACY_INPUT_MODES}${kitty}${ansi.showCursor}${ansi.altScreenOff}${ansi.reset}`;
}
