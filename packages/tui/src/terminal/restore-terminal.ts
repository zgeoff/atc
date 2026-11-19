import { ansi } from '@atc/core';

export function restoreTerminal(): void {
  process.stdout.write(ansi.resetInputModes + ansi.showCursor + ansi.altScreenOff + ansi.reset);

  try {
    process.stdin.setRawMode(false);
  } catch {}
}
