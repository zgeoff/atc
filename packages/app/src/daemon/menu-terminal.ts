import type { Clock } from '@atc/core';
import type { ScreenMenu } from '@atc/plugin-api';

/**
 * The session's terminal as a menu read or choice drives it: a fresh read
 * of the menu its screen shows, when its agent last printed anything, a
 * write to its PTY, and whether that PTY still runs. It also keeps the
 * whole menu atc last read through a list that scrolls, so a later read of
 * part of that list numbers its options the same way.
 */
export interface MenuTerminal {
  readonly readScreenMenu: () => Promise<ScreenMenu | null>;
  readonly readLastOutputAt: () => number;
  readonly write: (data: string) => void;
  readonly isLive: () => boolean;
  readonly findWholeMenu: () => ScreenMenu | null;
  readonly recordWholeMenu: (menu: ScreenMenu) => void;
}

/**
 * How long a menu read or choice waits on the screen. Before its first key
 * it waits for the agent to print nothing for `quietMs`, at most
 * `quietCapMs` in all. An arrow key gets `moveMs` to move the cursor. After
 * the last key, the screen counts as settled once it stays the same for
 * `stableMs`, or once `settleMs` passes.
 */
export interface MenuTiming {
  readonly pollMs: number;
  readonly quietMs: number;
  readonly quietCapMs: number;
  readonly moveMs: number;
  readonly settleMs: number;
  readonly stableMs: number;
}

// The quiet wait outlasts the hold Claude Code puts on a dialog that has
// just opened.
export const MENU_TIMING: MenuTiming = {
  pollMs: 50,
  quietMs: 4000,
  quietCapMs: 10_000,
  moveMs: 1500,
  settleMs: 4000,
  stableMs: 300,
};

/**
 * The clock a menu read or choice reads the time from and waits on, and
 * how long it waits.
 */
export interface MenuWaits {
  readonly clock: Clock;
  readonly timing: MenuTiming;
}

export const MENU_KEYS = {
  up: '\u001B[A',
  down: '\u001B[B',
  enter: '\r',
  escape: '\u001B',
} as const;
