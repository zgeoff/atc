export interface ImpHost {
  readonly name: string;
  harnesses: number;
  renewTimer: ReturnType<typeof setInterval> | null;
  suspending: boolean;

  // The daemon's check that nothing runs or starts on the host, from its
  // latest readying; null until one gives it.
  isIdle: (() => boolean) | null;

  log: ((line: string) => void) | null;

  readonly sleepRefusals: Set<() => void>;
}
