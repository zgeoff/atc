import type { Colour } from '../compositor/types';
import { buildPlaceRuns } from './build-place-runs';
import type { PlaceRun } from './build-place-runs';
import { buildRightEnd } from './build-right-end';
import { PLACE_SEPARATOR } from './constants';
import type { FleetBar, PlaceSummary } from './types';

export interface FleetBarRun {
  readonly col: number;
  readonly text: string;
  readonly fg: Colour;
  readonly bold: boolean;
}

const AMBER = rgb(0xf0, 0xb4, 0x5a);
const BLUE = rgb(0x7a, 0xa2, 0xf7);
const MUTED = rgb(0x6e, 0x76, 0x81);

// The runs of text the bar draws on its row, each with its start column and its colour.
export function formatFleetBar(bar: FleetBar, cols: number): readonly FleetBarRun[] {
  const runs: FleetBarRun[] = [];
  let col = 0;

  for (const [index, place] of bar.places.entries()) {
    if (index > 0) {
      col += PLACE_SEPARATOR.length;
    }

    for (const run of buildPlaceRuns(place, bar.level)) {
      const fg = pickRunColour(run, place);

      runs.push({ col, text: run.text, fg, bold: false });

      col += [...run.text].length;
    }
  }

  if (bar.dropped > 0) {
    runs.push({ col, text: '…', fg: MUTED, bold: false });
  }

  const right = buildRightEnd(bar.needYou, bar.leaderLabel, cols);
  const rightCol = Math.max(0, cols - right.width);

  if (right.needYouText !== '') {
    runs.push({ col: rightCol, text: right.needYouText, fg: AMBER, bold: false });
  }

  runs.push({
    col: rightCol + [...right.needYouText].length + right.gap,
    text: right.leaderLabel,
    fg: BLUE,
    bold: true,
  });

  return runs;
}

function pickRunColour(run: PlaceRun, place: PlaceSummary): Colour {
  if (run.kind === 'label') {
    return place.colour;
  }

  return run.kind === 'glyph' ? pickGlyphColour(run.text.trim(), place.reachable) : MUTED;
}

const UNREACHABLE = rgb(0x3a, 0x41, 0x4b);
const RUNNING = rgb(0x7d, 0xcf, 0xff);
const DONE = rgb(0x9e, 0xce, 0x6a);

function pickGlyphColour(glyph: string, isReachable: boolean): Colour {
  if (!isReachable) {
    return UNREACHABLE;
  }

  if (glyph === '◆') {
    return AMBER;
  }

  if (glyph === '✓') {
    return DONE;
  }

  return glyph === '○' || glyph === '?' ? MUTED : RUNNING;
}

function rgb(red: number, green: number, blue: number): Colour {
  return { kind: 'rgb', red, green, blue };
}
