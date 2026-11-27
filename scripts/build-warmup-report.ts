export interface WarmupTiming {
  readonly step: string;
  readonly durationMs: number;
}

export function buildWarmupReport(timings: readonly WarmupTiming[]): string {
  return timings
    .map(
      (timing) => `docker warm-up: ${timing.step} took ${String(Math.round(timing.durationMs))} ms`,
    )
    .join('\n');
}
