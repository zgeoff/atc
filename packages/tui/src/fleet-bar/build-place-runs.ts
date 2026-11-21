import type { FleetBarLevel, PlaceSummary } from './types';

export interface PlaceRun {
  readonly text: string;
  readonly kind: 'label' | 'glyph' | 'plain';
}

const SHORT_LABEL_LENGTH = 3;

// The pieces of one place's text at a level, in drawing order.
export function buildPlaceRuns(place: PlaceSummary, level: FleetBarLevel): readonly PlaceRun[] {
  const mark = place.reachable ? '' : '?';

  if (level === 'short') {
    return [
      { text: `${[...place.label].slice(0, SHORT_LABEL_LENGTH).join('')}${mark}`, kind: 'label' },
    ];
  }

  const label: PlaceRun = { text: `${place.label}${mark}`, kind: 'label' };

  if (level === 'counts') {
    return [
      label,
      { text: ` ${place.count}`, kind: 'plain' },
      ...(place.needYou > 0 ? [{ text: ' ◆', kind: 'glyph' as const }] : []),
    ];
  }

  return [
    label,
    { text: ' ', kind: 'plain' },
    ...place.glyphs.map((glyph) => ({ text: glyph, kind: 'glyph' as const })),
    ...(place.more > 0 ? [{ text: ` +${place.more}`, kind: 'plain' as const }] : []),
  ];
}

export function measureRuns(runs: readonly PlaceRun[]): number {
  return runs.reduce((total, run) => total + [...run.text].length, 0);
}
