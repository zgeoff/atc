import type { SessionViewState } from '@atc/protocol';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// The time since a session entered its state, as `6s`, `4m`, `3h` or `2d`. A session in `running`,
// and one whose state time the TUI never saw, has none.
export function formatAge(
  state: SessionViewState,
  stateSinceMs: number | null,
  nowMs: number,
): string {
  if (stateSinceMs === null || state === 'running' || state === 'unknown') {
    return '';
  }

  const elapsedMs = Math.max(0, nowMs - stateSinceMs);

  if (elapsedMs < MINUTE_MS) {
    return `${Math.floor(elapsedMs / SECOND_MS)}s`;
  }

  if (elapsedMs < HOUR_MS) {
    return `${Math.floor(elapsedMs / MINUTE_MS)}m`;
  }

  return elapsedMs < DAY_MS
    ? `${Math.floor(elapsedMs / HOUR_MS)}h`
    : `${Math.floor(elapsedMs / DAY_MS)}d`;
}
