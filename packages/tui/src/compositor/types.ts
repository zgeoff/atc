export interface RGB {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

export type Colour =
  | { readonly kind: 'default' }
  | { readonly kind: 'rgb'; readonly red: number; readonly green: number; readonly blue: number }
  | { readonly kind: 'palette'; readonly index: number };

export type Underline = 'none' | 'single' | 'double' | 'curly';

export interface Cell {
  readonly ch: string;
  readonly fg: Colour;
  readonly bg: Colour;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: Underline;
  readonly strikethrough: boolean;
  readonly inverse: boolean;
  readonly link: string | null;
}

export type CursorShape = 'block' | 'underline' | 'bar';

export interface CursorPlacement {
  readonly col: number;
  readonly row: number;
  readonly visible: boolean;
  readonly shape: CursorShape;
}

export type ColourDepth = 'truecolor' | '256' | '16';

export interface TerminalFacts {
  readonly depth: ColourDepth;
  readonly background: RGB;
  readonly foreground: RGB;
  readonly kittyKeyboard: boolean;
}

export interface FrameInfo {
  readonly now: number;
  readonly cols: number;
  readonly rows: number;
  readonly terminal: TerminalFacts;
}

export interface CellBuffer {
  readonly cols: number;
  readonly rows: number;
  readonly get: (col: number, row: number) => Cell;
  readonly set: (col: number, row: number, cell: Cell) => void;
}

export interface Layer {
  readonly draw: (buffer: CellBuffer, frame: FrameInfo) => void;
  readonly nextFrameAt: (nowMs: number) => number | null;
}
