import { CLOSE_FADE_MS, OPEN_FADE_MS, ROW_DELAY_MS, ROW_FADE_MS, ROW_STEP_MS } from './constants';

export type ListPhase =
  | { readonly kind: 'closed' }
  | { readonly kind: 'opening'; readonly startedAtMs: number }
  | { readonly kind: 'closing'; readonly startedAtMs: number };

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

// The fades of the panel at one moment. Opening fades in the dim and the frame over 180 ms, and
// row `i` fades in over 180 ms from 80 + 18·i ms. Closing fades everything out over 120 ms. With
// animations off the panel is whole at once and gone at once.
export function pickListMotion(
  phase: ListPhase,
  nowMs: number,
  options: MotionOptions,
): ListMotion {
  if (phase.kind === 'closed' || (phase.kind === 'closing' && !options.animations)) {
    return { isVisible: false, isMoving: false, dim: 0, frame: 0, row: () => 0 };
  }

  const elapsedMs = nowMs - phase.startedAtMs;

  if (phase.kind === 'closing') {
    const left = clamp(1 - elapsedMs / CLOSE_FADE_MS);

    return { isVisible: left > 0, isMoving: left > 0, dim: left, frame: left, row: () => left };
  }

  if (!options.animations) {
    return { isVisible: true, isMoving: false, dim: 1, frame: 1, row: () => 1 };
  }

  const frame = clamp(elapsedMs / OPEN_FADE_MS);
  const lastRowEndMs = ROW_DELAY_MS + ROW_STEP_MS * Math.max(0, options.rowCount - 1) + ROW_FADE_MS;

  return {
    isVisible: true,
    isMoving: elapsedMs < Math.max(OPEN_FADE_MS, lastRowEndMs),
    dim: frame,
    frame,
    row: (index) => clamp((elapsedMs - ROW_DELAY_MS - ROW_STEP_MS * index) / ROW_FADE_MS),
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
