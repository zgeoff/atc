import { measureWidth } from '../terminal/measure-width';
import { splitGraphemes } from '../terminal/split-graphemes';
import type { FleetBarLevel, PlaceSummary } from './types';

export interface PlaceRun {
  readonly text: string;
  readonly kind: 'label' | 'glyph' | 'plain';
}

const SHORT_LABEL_COLS = 3;

// The pieces of one place's text at a level, in drawing order.
export function buildPlaceRuns(place: PlaceSummary, level: FleetBarLevel): readonly PlaceRun[] {
  const mark = place.reachable ? '' : '?';
  const name = level === 'short' ? clipToWidth(place.label, SHORT_LABEL_COLS) : place.label;
  const label: PlaceRun = { text: `${name}${mark}`, kind: 'label' };

  if (level === 'glyphs') {
    return [
      label,
      { text: ' ', kind: 'plain' },
      ...place.glyphs.map((glyph) => ({ text: glyph, kind: 'glyph' as const })),
      ...(place.more > 0 ? [{ text: ` +${place.more}`, kind: 'plain' as const }] : []),
    ];
  }

  return [
    label,
    { text: ` ${place.count}`, kind: 'plain' },
    ...(place.needYou > 0 ? [{ text: ' ◆', kind: 'glyph' as const }] : []),
  ];
}

export function measureRuns(runs: readonly PlaceRun[]): number {
  return runs.reduce((total, run) => total + measureWidth(run.text), 0);
}

function clipToWidth(text: string, cols: number): string {
  let used = 0;
  let clipped = '';

  for (const grapheme of splitGraphemes(text)) {
    if (used + grapheme.width > cols) {
      break;
    }

    used += grapheme.width;
    clipped += grapheme.text;
  }

  return clipped;
}
