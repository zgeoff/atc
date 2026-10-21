// How far back failures count, and how many within that window delay the
// next handshake from the same address.
const FAILURE_WINDOW_MS = 60_000;
const FAILURE_LIMIT = 5;

export interface HandshakeThrottle {
  readonly recordFailure: (address: string, now: number) => void;
  readonly getDelay: (address: string, now: number) => number;
}

// a delay rather than a lockout slows a token guesser without locking out a peer that
// recovers
export function createHandshakeThrottle(delayMs: number): HandshakeThrottle {
  const failures = new Map<string, number[]>();

  const collectRecent = (address: string, now: number): number[] =>
    (failures.get(address) ?? []).filter((at) => now - at < FAILURE_WINDOW_MS);

  return {
    recordFailure: (address, now) => {
      // Only the latest failures up to the limit decide a delay, so an
      // address never holds more than that many, however often it fails.
      const recent = [...collectRecent(address, now), now].slice(-FAILURE_LIMIT);

      failures.set(address, recent);
    },

    getDelay: (address, now) => {
      const recent = collectRecent(address, now);

      if (recent.length === 0) {
        failures.delete(address);
      } else {
        failures.set(address, recent);
      }

      return recent.length >= FAILURE_LIMIT ? delayMs : 0;
    },
  };
}
