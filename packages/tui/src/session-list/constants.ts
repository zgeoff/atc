import type { RGB } from '../compositor/types';

export const PANEL_BACKGROUND: RGB = { red: 0x0f, green: 0x14, blue: 0x24 };
export const BORDER_COLOUR: RGB = { red: 0x2a, green: 0x33, blue: 0x50 };
export const BLUE: RGB = { red: 0x7a, green: 0xa2, blue: 0xf7 };
export const AMBER: RGB = { red: 0xf0, green: 0xb4, blue: 0x5a };
export const TEXT: RGB = { red: 0xc0, green: 0xca, blue: 0xf5 };
export const MUTED: RGB = { red: 0x6e, green: 0x76, blue: 0x81 };
export const FAINT: RGB = { red: 0x4a, green: 0x52, blue: 0x68 };
export const RUNNING: RGB = { red: 0x7d, green: 0xcf, blue: 0xff };
export const DONE: RGB = { red: 0x9e, green: 0xce, blue: 0x6a };

// how much of the panel's background covers the cell below it
export const PANEL_OPACITY = 0.86;

// how far the selected row's background moves toward blue
export const SELECTED_TINT = 0.11;

// how far the layers below the panel move toward the terminal's background
export const DIM_OVER_SESSION = 0.62;
export const DIM_OVER_HOME = 0.5;
export const WIDE_PANEL_COLS = 90;
export const MAX_PANEL_WIDTH = 112;

// the columns the terminal keeps beside the panel, and the rows it keeps above and below it
export const PANEL_MARGIN_COLS = 8;
export const PANEL_MARGIN_ROWS = 6;
export const OPEN_FADE_MS = 180;
export const ROW_DELAY_MS = 80;
export const ROW_STEP_MS = 18;
export const ROW_FADE_MS = 180;
export const CLOSE_FADE_MS = 120;

// the border, then a space, then the bar of a row
export const CONTENT_COL = 2;
