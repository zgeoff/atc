import type { Clock } from '@atc/core/system-clock';
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

/**
 * Prints sign-in events as `atc security {json}` lines, capped per kind and
 * window so a flood of bad requests cannot flood the journal. A kind's
 * window starts at its first event. Past the cap, events are dropped and
 * counted, and once the window ends the log prints one `suppressed` event
 * with the kind and the count, then starts the kind afresh on its next
 * event. The window's end is scheduled on the clock when its first event is
 * dropped, so the count prints even if no further request arrives.
 */
export class SecurityEventLog {
  private readonly opts: SecurityEventLogOptions;

  private readonly windows = new Map<SecurityEvent['kind'], KindWindow>();

  constructor(opts: SecurityEventLogOptions) {
    this.opts = opts;
  }

  record(event: SecurityEvent): void {
    const now = this.opts.clock.now();

    this.drainEnded(now);

    let window = this.windows.get(event.kind);

    if (window === undefined) {
      window = { startedAt: now, printed: 0, dropped: 0, cancelFlush: null };

      this.windows.set(event.kind, window);
    }

    if (window.printed < MAX_EVENTS_PER_WINDOW) {
      window.printed++;

      this.opts.print(formatSecurityEvent(event, now));

      return;
    }

    window.dropped++;

    window.cancelFlush ??= this.opts.clock.schedule(
      () => {
        this.drainEnded(this.opts.clock.now());
      },
      window.startedAt + WINDOW_MS - now,
    );
  }

  /**
   * Prints the `suppressed` event of every window that dropped events and
   * forgets every window, for a server that stops.
   */
  drain(): void {
    for (const [kind, window] of this.windows) {
      this.printSuppressed(kind, window, this.opts.clock.now());
    }

    this.windows.clear();
  }

  private drainEnded(now: number): void {
    for (const [kind, window] of this.windows) {
      if (now - window.startedAt >= WINDOW_MS) {
        this.windows.delete(kind);
        this.printSuppressed(kind, window, now);
      }
    }
  }

  private printSuppressed(kind: SecurityEvent['kind'], window: KindWindow, now: number): void {
    window.cancelFlush?.();

    if (window.dropped > 0) {
      this.opts.print(
        formatSecurityEvent({ kind: 'suppressed', reason: kind, count: window.dropped }, now),
      );
    }
  }
}
