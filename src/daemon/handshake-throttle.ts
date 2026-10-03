// How far back failures count, and how many within that window delay the
// next handshake from the same address.
const FAILURE_WINDOW_MS = 60_000;
const FAILURE_LIMIT = 5;

/**
 * Failed TCP handshakes per source address. Once an address has failed
 * five times within a minute, its next handshake waits the configured
 * delay before the daemon checks it, which slows a token guesser without
 * locking out a peer that recovers.
 */
export class HandshakeThrottle {
  private readonly delayMs: number;

  private readonly failures = new Map<string, number[]>();

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  recordFailure(address: string, now: number): void {
    const recent = this.collectRecent(address, now);

    recent.push(now);
    this.failures.set(address, recent);
  }

  /**
   * How long the next handshake from the address waits, in milliseconds.
   */
  getDelay(address: string, now: number): number {
    const recent = this.collectRecent(address, now);

    if (recent.length === 0) {
      this.failures.delete(address);
    } else {
      this.failures.set(address, recent);
    }

    return recent.length >= FAILURE_LIMIT ? this.delayMs : 0;
  }

  private collectRecent(address: string, now: number): number[] {
    return (this.failures.get(address) ?? []).filter((at) => now - at < FAILURE_WINDOW_MS);
  }
}
