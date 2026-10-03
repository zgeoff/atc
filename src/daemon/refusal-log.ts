import { formatLogField } from './format-log-field';

// Why the TCP listener refused a handshake: a missing token, a wrong one, a
// handshake that would wait while the cap of delayed handshakes is full, a
// socket that closed while its handshake waited, a line other than one
// handshake before the handshake passed, or a line over the size cap
// before it passed.
type HandshakeRefusalReason =
  | 'missing_token'
  | 'unauthorized'
  | 'delay_cap_full'
  | 'closed_during_delay'
  | 'unexpected_line'
  | 'line_too_long';

export type Refusal =
  | {
      readonly event: 'handshake_refused';
      readonly peer: string;
      readonly reason: HandshakeRefusalReason;
    }
  | {
      readonly event: 'principal_refused';
      readonly peer: string;
      readonly principal: string;
    };

interface RefusalLogOptions {
  readonly log: (line: string) => void;
  readonly now: () => number;

  // How long a window of repeated refusals lasts before the next one is
  // logged again.
  readonly intervalMs: number;

  // How many windows are tracked at once; a new one past the cap ends the
  // oldest early.
  readonly maxWindows: number;
}

interface RefusalWindow {
  readonly startedAt: number;

  // The refusals in the window after the first, which no line holds yet.
  pending: number;
}

/**
 * Logs TCP listener refusals as `key=value` lines, at most one per window
 * for each peer and kind of refusal. The first refusal of a window logs at
 * once with `count=1`; later ones in the window are counted, and a line
 * with their `count` follows once the window ends, so the counts of every
 * line sum to every refusal. Ended windows are logged on the next refusal
 * from any peer and on a drain.
 */
export class RefusalLog {
  private readonly opts: RefusalLogOptions;

  // Keyed by the line without its count, in the order the windows started.
  private readonly windows = new Map<string, RefusalWindow>();

  constructor(opts: RefusalLogOptions) {
    this.opts = opts;
  }

  record(refusal: Refusal): void {
    const now = this.opts.now();

    this.drainEnded(now);

    const line = formatRefusal(refusal);
    const window = this.windows.get(line);

    if (window !== undefined) {
      window.pending++;

      return;
    }

    if (this.windows.size >= this.opts.maxWindows) {
      this.drainOldest();
    }

    this.windows.set(line, { startedAt: now, pending: 0 });
    this.opts.log(`${line} count=1`);
  }

  /**
   * Logs the pending count of every window and forgets them all.
   */
  drain(): void {
    for (const [line, window] of this.windows) {
      this.logPending(line, window);
    }

    this.windows.clear();
  }

  // Windows start in map order and all last the same interval, so the
  // ended ones lead the map.
  private drainEnded(now: number): void {
    for (const [line, window] of this.windows) {
      if (now - window.startedAt < this.opts.intervalMs) {
        return;
      }

      this.windows.delete(line);
      this.logPending(line, window);
    }
  }

  private drainOldest(): void {
    const oldest = this.windows.entries().next();

    if (oldest.done === true) {
      return;
    }

    const [line, window] = oldest.value;

    this.windows.delete(line);
    this.logPending(line, window);
  }

  private logPending(line: string, window: Readonly<RefusalWindow>): void {
    if (window.pending > 0) {
      this.opts.log(`${line} count=${window.pending}`);
    }
  }
}

function formatRefusal(refusal: Refusal): string {
  const peer = formatLogField(refusal.peer);

  return refusal.event === 'handshake_refused'
    ? `atc tcp event=handshake_refused peer=${peer} reason=${refusal.reason}`
    : `atc tcp event=principal_refused peer=${peer} principal=${formatLogField(refusal.principal)}`;
}
