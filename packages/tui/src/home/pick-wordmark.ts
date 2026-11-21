import type { Wordmark } from './types';

interface WindowSize {
  readonly cols: number;
  readonly rows: number;
}

// The largest wordmark whose smallest window the window reaches, in columns and in rows.
export function pickWordmark(window: WindowSize): Wordmark {
  if (window.cols >= 164 && window.rows >= 50) {
    return { kind: 'outline', size: 's10' };
  }

  if (window.cols >= 136 && window.rows >= 40) {
    return { kind: 'outline', size: 'xs8' };
  }

  if (window.cols >= 30 && window.rows >= 10) {
    return { kind: 'bitmap' };
  }

  return { kind: 'text' };
}
