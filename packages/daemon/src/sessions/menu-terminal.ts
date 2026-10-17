import type { Clock } from '@atc/core';
import type { ScreenMenu } from '@atc/plugin-api';

export interface MenuTerminal {
  readonly readScreenMenu: () => Promise<ScreenMenu | null>;
  readonly readLastOutputAt: () => number;
  readonly write: (data: string) => void;
  readonly isLive: () => boolean;

  // the whole menu last read through a scrolling list, so a later read of part of it numbers its
  // options the same way
  readonly findWholeMenu: () => ScreenMenu | null;
  readonly recordWholeMenu: (menu: ScreenMenu | null) => void;
}

export interface MenuTiming {
  readonly pollMs: number;

  // before the first key: no output for quietMs, waiting at most quietCapMs in all
  readonly quietMs: number;
  readonly quietCapMs: number;
  readonly moveMs: number;

  // after the last key: settled once the screen holds for stableMs, or once settleMs passes
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
