import type { SessionViewState } from '@atc/protocol';
import { match } from 'ts-pattern';
import type { DaemonName } from '../fleet/session-key';
import { pickPlaceColour } from '../places/pick-place-colour';
import { pickPlaceLabels } from '../places/pick-place-labels';
import { buildPlaceRuns, measureRuns } from './build-place-runs';
import { buildRightEnd } from './build-right-end';
import { BAR_MARGIN, MIN_GAP, PLACE_SEPARATOR, SPINNER_FRAMES } from './constants';
import type { FleetBar, FleetBarLevel, FleetBarSession, PlaceSummary } from './types';

const LEVELS: readonly FleetBarLevel[] = ['glyphs', 'counts', 'short'];

export interface FleetBarOptions {
  readonly cols: number;
  readonly leaderLabel: string;
  readonly attachedPlaceKey: string | null;

  // the daemons in config order, which pick a place's label
  readonly daemonOrder?: readonly DaemonName[];

  // daemons whose link is not up; their places keep the sessions last listed
  readonly downDaemons?: ReadonlySet<DaemonName>;
  readonly spinnerFrame?: number;
}

export function buildFleetBar(
  sessions: readonly FleetBarSession[],
  options: Readonly<FleetBarOptions>,
): FleetBar {
  const summaries = buildPlaceSummaries(sessions, options);
  const needYou = summaries.reduce((total, place) => total + place.needYou, 0);
  const right = buildRightEnd(needYou, options.leaderLabel, options.cols);
  const available = options.cols - BAR_MARGIN * 2 - right.width - MIN_GAP;
  const base = { needYou, leaderLabel: options.leaderLabel };

  for (const level of LEVELS) {
    if (measurePlaces(summaries, level) <= available) {
      return { ...base, level, places: summaries, dropped: 0 };
    }
  }

  const places = summaries.slice(0, countPlacesThatFit(summaries, available));

  return { ...base, level: 'short', places, dropped: summaries.length - places.length };
}

const MAX_GLYPHS = 4;

function buildPlaceSummaries(
  sessions: readonly FleetBarSession[],
  options: Readonly<FleetBarOptions>,
): readonly PlaceSummary[] {
  const labels = pickPlaceLabels(sessions, options.daemonOrder ?? []);
  const downDaemons = options.downDaemons ?? new Set<DaemonName>();
  const spinner = SPINNER_FRAMES[(options.spinnerFrame ?? 0) % SPINNER_FRAMES.length] ?? '';

  const byKey = new Map<string, FleetBarSession[]>();

  for (const session of sessions) {
    byKey.set(session.place.key, [...(byKey.get(session.place.key) ?? []), session]);
  }

  const entries = [...byKey].map(([key, placed]) => {
    const glyphs = placed
      .toSorted((left, right) => rankState(left.state) - rankState(right.state))
      .map((session) => pickGlyph(session.state, spinner));

    const summary: PlaceSummary = {
      label: labels.get(key) ?? key,
      colour: pickPlaceColour(key),
      glyphs: glyphs.slice(0, MAX_GLYPHS),
      more: Math.max(0, glyphs.length - MAX_GLYPHS),
      count: placed.length,
      needYou: placed.filter((session) => session.state === 'needs_you').length,
      reachable: !placed.some((session) => downDaemons.has(session.daemon)),
    };

    return { key, summary };
  });

  return entries
    .toSorted((left, right) => {
      const leftFirst = left.key === options.attachedPlaceKey;
      const rightFirst = right.key === options.attachedPlaceKey;

      if (leftFirst !== rightFirst) {
        return leftFirst ? -1 : 1;
      }

      return compareCodeUnits(left.summary.label, right.summary.label);
    })
    .map((entry) => entry.summary);
}

function rankState(state: SessionViewState): number {
  return match(state)
    .with('needs_you', () => 0)
    .with('running', () => 1)
    .with('done', () => 2)
    .with('exited', () => 3)
    .with('unknown', () => 4)
    .exhaustive();
}

function pickGlyph(state: SessionViewState, spinner: string): string {
  return match(state)
    .with('needs_you', () => '◆')
    .with('running', () => spinner)
    .with('done', () => '✓')
    .with('exited', () => '○')
    .with('unknown', () => '?')
    .exhaustive();
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function measurePlaces(places: readonly PlaceSummary[], level: FleetBarLevel): number {
  return places.reduce(
    (total, place, index) =>
      total +
      measureRuns(buildPlaceRuns(place, level)) +
      (index === 0 ? 0 : PLACE_SEPARATOR.length),
    0,
  );
}

// The most places that fit at the short level, with a column left for the `…` after the last one
// when any place drops.
function countPlacesThatFit(places: readonly PlaceSummary[], available: number): number {
  for (let kept = places.length - 1; kept > 0; kept--) {
    if (measurePlaces(places.slice(0, kept), 'short') + 1 <= available) {
      return kept;
    }
  }

  return 0;
}
