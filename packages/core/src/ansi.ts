import { RESET_INPUT_MODES } from './reset-input-modes';

const ESC = '\u001B';

/**
 * The terminal control sequences atc writes: screen switches, clears,
 * cursor moves, and attribute and input-mode resets.
 */
export const ansi = {
  altScreenOn: `${ESC}[?1049h`,
  altScreenOff: `${ESC}[?1049l`,
  resetInputModes: RESET_INPUT_MODES,
  eraseScreen: `${ESC}[2J`,
  cursorHome: `${ESC}[H`,
  clear: `${ESC}[2J${ESC}[H`,
  hideCursor: `${ESC}[?25l`,
  showCursor: `${ESC}[?25h`,
  saveCursor: `${ESC}7`,
  restoreCursor: `${ESC}8`,
  reset: `${ESC}[0m`,
  moveTo: (row: number, col: number) => `${ESC}[${row};${col}H`,
} as const;
