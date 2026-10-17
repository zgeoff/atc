import { formatLogField } from '../format-log-field';

// Why the TCP listener refused a handshake, each before the handshake passed.
type HandshakeRefusalReason =
  | 'missing_token'
  | 'unauthorized'
  | 'delay_cap_full'
  | 'closed_during_delay'
  | 'unexpected_line'
  | 'line_too_long';

type Refusal =
  | {
      readonly event: 'handshake_refused';
      readonly peer: string;
      readonly reason: HandshakeRefusalReason;
    }
  | {
      readonly event: 'principal_refused';
      readonly peer: string;
    };

interface RefusalLogOptions {
  readonly log: (line: string) => void;
  readonly now: () => number;

  // How long a window of repeated refusals lasts before the next one is
  // logged again.
  readonly intervalMs: number;

  // How many windows are tracked at once; a refusal that would start one
  // past the cap counts toward one overflow window instead.
  readonly maxWindows: number;
}

interface RefusalWindow {
  readonly startedAt: number;

  // The refusals in the window after the first, which no line holds yet.
  pending: number;
}

// The line of the window that counts refusals past the cap of windows.
const OVERFLOW_LINE = 'atc tcp event=refused peer=overflow';

// one line per peer and kind of refusal per window, so a flood across many peers logs no
// more lines than the cap of windows allows; the counts of every line sum to every refusal
export class RefusalLog {
  private readonly opts: RefusalLogOptions;

  // Keyed by the line without its count, in the order the windows started.
  private readonly windows = new Map<string, RefusalWindow>();

  private overflow: RefusalWindow | null = null;

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
      this.recordOverflow(now);

      return;
    }

    this.windows.set(line, { startedAt: now, pending: 0 });
    this.opts.log(`${line} count=1`);
  }

  drain(): void {
    for (const [line, window] of this.windows) {
      this.logPending(line, window);
    }

    this.windows.clear();

    if (this.overflow !== null) {
      this.logPending(OVERFLOW_LINE, this.overflow);

      this.overflow = null;
    }
  }

  // Windows start in map order and all last the same interval, so the
  // ended ones lead the map.
  private drainEnded(now: number): void {
    if (this.overflow !== null && this.hasEnded(this.overflow, now)) {
      this.logPending(OVERFLOW_LINE, this.overflow);

      this.overflow = null;
    }

    for (const [line, window] of this.windows) {
      if (!this.hasEnded(window, now)) {
        return;
      }

      this.windows.delete(line);
      this.logPending(line, window);
    }
  }

  private hasEnded(window: Readonly<RefusalWindow>, now: number): boolean {
    return now - window.startedAt >= this.opts.intervalMs;
  }

  private logPending(line: string, window: Readonly<RefusalWindow>): void {
    if (window.pending > 0) {
      this.opts.log(`${line} count=${window.pending}`);
    }
  }

  private recordOverflow(now: number): void {
    if (this.overflow !== null) {
      this.overflow.pending++;

      return;
    }

    this.overflow = { startedAt: now, pending: 0 };

    this.opts.log(`${OVERFLOW_LINE} count=1`);
  }
}

function formatRefusal(refusal: Refusal): string {
  const peer = formatLogField(refusal.peer);

  return refusal.event === 'handshake_refused'
    ? `atc tcp event=handshake_refused peer=${peer} reason=${refusal.reason}`
    : `atc tcp event=principal_refused peer=${peer} principal=unlisted`;
}
