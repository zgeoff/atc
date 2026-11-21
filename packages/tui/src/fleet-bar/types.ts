import type { SessionViewState } from '@atc/protocol';
import type { Colour } from '../compositor/types';
import type { DaemonName } from '../fleet/session-key';
import type { SessionPlace } from '../places/types';

export type FleetBarLevel = 'glyphs' | 'counts' | 'short';

export interface FleetBarSession {
  readonly daemon: DaemonName;
  readonly state: SessionViewState;

  // the target id, which tells apart two places with one label on one daemon
  readonly target: string;
  readonly place: SessionPlace;
}

export interface PlaceSummary {
  readonly label: string;
  readonly colour: Colour;
  readonly glyphs: readonly string[];
  readonly more: number;
  readonly count: number;
  readonly needYou: number;

  // false while any daemon that serves this place is down
  readonly reachable: boolean;
}

export interface FleetBar {
  // the most detail that fits the columns
  readonly level: FleetBarLevel;
  readonly places: readonly PlaceSummary[];

  // places that did not fit
  readonly dropped: number;

  // across every place, dropped ones included
  readonly needYou: number;
  readonly leaderLabel: string;
}
