import {
  CLOSE_FADE_MS,
  MAX_ROW_STEP_MS,
  OPEN_FADE_MS,
  OPEN_TOTAL_MS,
  ROW_DELAY_MS,
  ROW_FADE_MS,
} from './constants';
import type { FadeLevels } from './types';

export type ListPhase =
  | { readonly kind: 'closed' }
  | { readonly kind: 'opening'; readonly startedAtMs: number; readonly from: FadeLevels }
  | { readonly kind: 'closing'; readonly startedAtMs: number; readonly from: FadeLevels };

export interface MotionOptions {
  readonly animations: boolean;
  readonly rowCount: number;
}

export interface ListMotion {
  // false once a closing panel has faded out
  readonly isVisible: boolean;

  // true while a fade still runs, so the layer needs another frame
  readonly isMoving: boolean;

  // how much of the dim the layers below get, from 0 to 1
  readonly dim: number;

  // how much of the panel's frame, title and last line shows, from 0 to 1
  readonly frame: number;

  // how much of a row shows, from 0 to 1, counting rows from 0
  readonly row: (index: number) => number;
}

// The fades of the panel at one moment, each from its level in `from`. Opening takes 250 ms at
// most: the frame fades over 180 ms, and each row over 100 ms, starting a step after the last. The
// step shrinks as the list grows. Closing takes 120 ms. With animations off, the panel is whole at once.
export function pickListMotion(
  phase: ListPhase,
  nowMs: number,
  options: MotionOptions,
): ListMotion {
  if (phase.kind === 'closed' || (phase.kind === 'closing' && !options.animations)) {
    return { isVisible: false, isMoving: false, dim: 0, frame: 0, row: () => 0 };
  }

  const elapsedMs = nowMs - phase.startedAtMs;
  const from = phase.from;
  const readFromRow = (index: number): number => from.rows[index] ?? from.frame;

  if (phase.kind === 'closing') {
    const left = clamp(1 - elapsedMs / CLOSE_FADE_MS);

    return {
      isVisible: left > 0,
      isMoving: left > 0,
      dim: from.dim * left,
      frame: from.frame * left,
      row: (index) => readFromRow(index) * left,
    };
  }

  if (!options.animations) {
    return { isVisible: true, isMoving: false, dim: 1, frame: 1, row: () => 1 };
  }

  const opened = clamp(elapsedMs / OPEN_FADE_MS);
  const gaps = Math.max(1, options.rowCount - 1);
  const stepMs = Math.min(MAX_ROW_STEP_MS, (OPEN_TOTAL_MS - ROW_DELAY_MS - ROW_FADE_MS) / gaps);
  const lastRowEndMs = ROW_DELAY_MS + stepMs * Math.max(0, options.rowCount - 1) + ROW_FADE_MS;

  return {
    isVisible: true,
    isMoving: elapsedMs < Math.max(OPEN_FADE_MS, lastRowEndMs),
    dim: raise(from.dim, opened),
    frame: raise(from.frame, opened),
    row: (index) =>
      raise(readFromRow(index), clamp((elapsedMs - ROW_DELAY_MS - stepMs * index) / ROW_FADE_MS)),
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// the level that a fade from `start` to 1 has reached after `share` of it
function raise(start: number, share: number): number {
  return start + (1 - start) * share;
}
