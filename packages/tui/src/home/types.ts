export type Wordmark =
  | { readonly kind: 'outline'; readonly size: 's10' | 'xs8' }
  | { readonly kind: 'bitmap' }
  | { readonly kind: 'text' };

export interface OutlineSize {
  // every stroke is this many whole pixels wide
  readonly stroke: number;
  readonly xHeight: number;

  // corner radius of the a and c bowls
  readonly radius: number;
  readonly aWidth: number;
  readonly cWidth: number;

  // how far the t rises above the x-height
  readonly ascender: number;

  // width of the t's crossbar
  readonly tWidth: number;

  // offset of the t's stem inside its crossbar, which centres the stem
  readonly tStem: number;

  // height of the cut that opens the c, centred on the bowl's middle
  readonly gap: number;

  // space between letters
  readonly track: number;
}

// How much of each pixel the wordmark covers, from 0 to 1, row by row. A cell is one pixel wide and
// two pixels tall, so the rows come in pairs.
export type Coverage = readonly (readonly number[])[];

export type HomeTone = 'plain' | 'mark' | 'amber' | 'blue';

// A piece of text on home, drawn at a column and row of the window.
export interface HomeRun {
  readonly col: number;
  readonly row: number;
  readonly text: string;
  readonly tone: HomeTone;
  readonly bold: boolean;
  readonly dim: boolean;
}

export interface HomeLayout {
  // where the wordmark's top left cell goes; the text wordmark is a run instead
  readonly wordmarkAt: { readonly col: number; readonly row: number };
  readonly runs: readonly HomeRun[];
}

// What home shows, read from the fleet and the window.
export interface HomeInput {
  readonly sessionCount: number;
  readonly needYouCount: number;
  readonly leaderLabel: string;

  // how many sessions of the last fleet the R key would restore
  readonly restorableCount: number;

  // lines for what the user still needs on home: a notice, an update, a daemon that is down
  readonly notices: readonly string[];
}
