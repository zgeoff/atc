import type { SessionViewState } from '@atc/protocol';
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from './constants';

// The moment after `nowMs` at which the age that formatAge gives next changes, or null for a
// session that shows no age.
export function findNextAgeChangeAt(
  state: SessionViewState,
  stateSinceMs: number | null,
  nowMs: number,
): number | null {
  if (stateSinceMs === null || state === 'running' || state === 'unknown') {
    return null;
  }

  const elapsedMs = Math.max(0, nowMs - stateSinceMs);
  const stepMs = pickAgeStep(elapsedMs);

  return stateSinceMs + (Math.floor(elapsedMs / stepMs) + 1) * stepMs;
}

function pickAgeStep(elapsedMs: number): number {
  if (elapsedMs < MINUTE_MS) {
    return SECOND_MS;
  }

  if (elapsedMs < HOUR_MS) {
    return MINUTE_MS;
  }

  return elapsedMs < DAY_MS ? HOUR_MS : DAY_MS;
}
