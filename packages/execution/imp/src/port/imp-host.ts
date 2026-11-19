// What the provider follows of one imp: its name, how many harnesses run
// there, the renewal holding the daemon's lease, and whether a sleep or a
// destroy the provider asked for is ending its connections.
export interface ImpHost {
  readonly name: string;
  harnesses: number;
  renewTimer: ReturnType<typeof setInterval> | null;
  suspending: boolean;

  // The daemon's check that nothing runs or starts on the host, from its
  // latest readying; null until one gives it.
  isIdle: (() => boolean) | null;

  // Where the latest readying asked the provider to report, or null.
  log: ((line: string) => void) | null;

  // Called once each when impd refuses a sleep or fails a destroy the
  // provider asked for, and the host stays awake.
  readonly sleepRefusals: Set<() => void>;
}
