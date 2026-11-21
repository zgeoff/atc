import { formatTerminalRestore } from './format-terminal-restore';

export function restoreTerminal(hasKittyKeyboard: boolean): void {
  process.stdout.write(formatTerminalRestore(hasKittyKeyboard));

  try {
    process.stdin.setRawMode(false);
  } catch {}
}
