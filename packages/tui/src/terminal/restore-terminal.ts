import { ansi } from '@atc/core';

// Leaves the alternate screen and gives the terminal back in its cooked mode.
export function restoreTerminal(): void {
  process.stdout.write(ansi.resetInputModes + ansi.showCursor + ansi.altScreenOff + ansi.reset);

  try {
    process.stdin.setRawMode(false);
  } catch {}
}
