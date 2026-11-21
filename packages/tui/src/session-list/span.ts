import type { RGB } from '../compositor/types';
import type { PanelSpan } from './types';

export function span(col: number, text: string, fg: RGB): PanelSpan {
  return { col, text, fg, bold: false };
}
