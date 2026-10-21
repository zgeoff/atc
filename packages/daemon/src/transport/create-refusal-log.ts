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

export interface RefusalLog {
  readonly record: (refusal: Refusal) => void;
  readonly drain: () => void;
}

// one line per peer and kind of refusal per window, so a flood across many peers logs no
// more lines than the cap of windows allows; the counts of every line sum to every refusal
export function createRefusalLog(opts: RefusalLogOptions): RefusalLog {
  // Keyed by the line without its count, in the order the windows started.
  const windows = new Map<string, RefusalWindow>();

  let overflow: RefusalWindow | null = null;

  const hasEnded = (window: Readonly<RefusalWindow>, now: number): boolean =>
    now - window.startedAt >= opts.intervalMs;

  const logPending = (line: string, window: Readonly<RefusalWindow>): void => {
    if (window.pending > 0) {
      opts.log(`${line} count=${window.pending}`);
    }
  };

  // Windows start in map order and all last the same interval, so the
  // ended ones lead the map.
  const drainEnded = (now: number): void => {
    if (overflow !== null && hasEnded(overflow, now)) {
      logPending(OVERFLOW_LINE, overflow);

      overflow = null;
    }

    for (const [line, window] of windows) {
      if (!hasEnded(window, now)) {
        return;
      }

      windows.delete(line);

      logPending(line, window);
    }
  };

  const recordOverflow = (now: number): void => {
    if (overflow !== null) {
      overflow.pending++;

      return;
    }

    overflow = { startedAt: now, pending: 0 };

    opts.log(`${OVERFLOW_LINE} count=1`);
  };

  return {
    record: (refusal) => {
      const now = opts.now();

      drainEnded(now);

      const line = formatRefusal(refusal);
      const window = windows.get(line);

      if (window !== undefined) {
        window.pending++;

        return;
      }

      if (windows.size >= opts.maxWindows) {
        recordOverflow(now);

        return;
      }

      windows.set(line, { startedAt: now, pending: 0 });
      opts.log(`${line} count=1`);
    },

    drain: () => {
      for (const [line, window] of windows) {
        logPending(line, window);
      }

      windows.clear();

      if (overflow !== null) {
        logPending(OVERFLOW_LINE, overflow);

        overflow = null;
      }
    },
  };
}

function formatRefusal(refusal: Refusal): string {
  const peer = formatLogField(refusal.peer);

  return refusal.event === 'handshake_refused'
    ? `atc tcp event=handshake_refused peer=${peer} reason=${refusal.reason}`
    : `atc tcp event=principal_refused peer=${peer} principal=unlisted`;
}
