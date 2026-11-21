import type { Cell } from './types';

export const BLANK_CELL: Cell = {
  ch: ' ',
  fg: { kind: 'default' },
  bg: { kind: 'default' },
  bold: false,
  dim: false,
  italic: false,
  underline: 'none',
  strikethrough: false,
  inverse: false,
  link: null,
};
