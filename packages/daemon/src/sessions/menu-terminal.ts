import type { Clock } from '@atc/core';
import type { ScreenMenu } from '@atc/plugin-api';

export interface MenuTerminal {
  readonly readScreenMenu: () => Promise<ScreenMenu | null>;
  readonly readLastOutputAt: () => number;
  readonly write: (data: string) => void;
  readonly isLive: () => boolean;

  // A menu read through a scrolling list is numbered differently from a partial read of the same
  // menu, so later partial reads reuse this one's numbering.
  readonly findWholeMenu: () => ScreenMenu | null;
  readonly recordWholeMenu: (menu: ScreenMenu | null) => void;
}

export interface MenuTiming {
  readonly pollMs: number;

  readonly quietMs: number;
  readonly quietCapMs: number;
  readonly moveMs: number;

  readonly settleMs: number;
  readonly stableMs: number;
}

// Claude Code holds a freshly opened dialog for a while before it accepts input, so the quiet
// wait has to be longer than that hold.
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
