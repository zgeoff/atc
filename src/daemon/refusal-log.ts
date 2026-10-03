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
  // The window's line without its count.
  readonly line: string;
  readonly startedAt: number;

  // The refusals in the window after the first, which no line holds yet.
  pending: number;
}

/**
 * Logs TCP listener refusals as `key=value` lines, at most one per window
 * for each peer and kind of refusal: a handshake refusal per reason, and a
 * principal refusal whatever principal it gave, whose line holds the first
 * principal of the window. The first refusal of a window logs at once with
 * `count=1`; later ones in the window are counted, and a line with their
 * `count` follows once the window ends, so the counts of every line sum to
 * every refusal. Ended windows are logged on the next refusal from any
 * peer and on a drain.
 */
export class RefusalLog {
  private readonly opts: RefusalLogOptions;

  // Keyed by the peer and kind of refusal, in the order the windows started.
  private readonly windows = new Map<string, RefusalWindow>();

  constructor(opts: RefusalLogOptions) {
    this.opts = opts;
  }

  record(refusal: Refusal): void {
    const now = this.opts.now();

    this.drainEnded(now);

    const key = buildWindowKey(refusal);
    const window = this.windows.get(key);

    if (window !== undefined) {
      window.pending++;

      return;
    }

    if (this.windows.size >= this.opts.maxWindows) {
      this.drainOldest();
    }

    const line = formatRefusal(refusal);

    this.windows.set(key, { line, startedAt: now, pending: 0 });
    this.opts.log(`${line} count=1`);
  }

  /**
   * Logs the pending count of every window and forgets them all.
   */
  drain(): void {
    for (const window of this.windows.values()) {
      this.logPending(window);
    }

    this.windows.clear();
  }

  // Windows start in map order and all last the same interval, so the
  // ended ones lead the map.
  private drainEnded(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt < this.opts.intervalMs) {
        return;
      }

      this.windows.delete(key);
      this.logPending(window);
    }
  }

  private drainOldest(): void {
    const oldest = this.windows.entries().next();

    if (oldest.done === true) {
      return;
    }

    const [key, window] = oldest.value;

    this.windows.delete(key);
    this.logPending(window);
  }

  private logPending(window: Readonly<RefusalWindow>): void {
    if (window.pending > 0) {
      this.opts.log(`${window.line} count=${window.pending}`);
    }
  }
}

// A NUL never appears in an address or a reason, so the parts cannot run
// together into another key.
function buildWindowKey(refusal: Refusal): string {
  return refusal.event === 'handshake_refused'
    ? `${refusal.event}\u0000${refusal.peer}\u0000${refusal.reason}`
    : `${refusal.event}\u0000${refusal.peer}`;
}

function formatRefusal(refusal: Refusal): string {
  const peer = formatLogField(refusal.peer);

  return refusal.event === 'handshake_refused'
    ? `atc tcp event=handshake_refused peer=${peer} reason=${refusal.reason}`
    : `atc tcp event=principal_refused peer=${peer} principal=${formatLogField(refusal.principal)}`;
}
