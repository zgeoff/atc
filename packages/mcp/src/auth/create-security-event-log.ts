import type { Clock } from '@atc/core';
import { formatSecurityEvent } from './format-security-event';
import type { SecurityEvent } from './types';

interface SecurityEventLogOptions {
  // Receives each `atc security {json}` line.
  readonly print: (line: string) => void;
  readonly clock: Clock;
}

interface KindWindow {
  readonly startedAt: number;
  printed: number;
  dropped: number;
  cancelFlush: (() => void) | null;
}

// Each kind prints at most this many events per window; the rest are
// counted and written as one `suppressed` event when the window ends.
const MAX_EVENTS_PER_WINDOW = 20;
const WINDOW_MS = 60_000;

export interface SecurityEventLog {
  readonly record: (event: SecurityEvent) => void;
  readonly drain: () => void;
}

export function createSecurityEventLog(opts: SecurityEventLogOptions): SecurityEventLog {
  const windows = new Map<SecurityEvent['kind'], KindWindow>();

  const printSuppressed = (
    kind: SecurityEvent['kind'],
    window: Readonly<KindWindow>,
    now: number,
  ): void => {
    window.cancelFlush?.();

    if (window.dropped > 0) {
      opts.print(
        formatSecurityEvent({ kind: 'suppressed', reason: kind, count: window.dropped }, now),
      );
    }
  };

  const drainEnded = (now: number): void => {
    for (const [kind, window] of windows) {
      if (now - window.startedAt >= WINDOW_MS) {
        windows.delete(kind);

        printSuppressed(kind, window, now);
      }
    }
  };

  return {
    record: (event) => {
      const now = opts.clock.now();

      drainEnded(now);

      let window = windows.get(event.kind);

      if (window === undefined) {
        window = { startedAt: now, printed: 0, dropped: 0, cancelFlush: null };

        windows.set(event.kind, window);
      }

      if (window.printed < MAX_EVENTS_PER_WINDOW) {
        window.printed++;

        opts.print(formatSecurityEvent(event, now));

        return;
      }

      window.dropped++;

      window.cancelFlush ??= opts.clock.schedule(
        () => {
          drainEnded(opts.clock.now());
        },
        window.startedAt + WINDOW_MS - now,
      );
    },

    drain: () => {
      for (const [kind, window] of windows) {
        printSuppressed(kind, window, opts.clock.now());
      }

      windows.clear();
    },
  };
}
