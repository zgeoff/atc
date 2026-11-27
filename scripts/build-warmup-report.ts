export function buildWarmupReport(step: string, durationMs: number): string {
  return `docker warm-up: ${step} took ${String(Math.round(durationMs))} ms`;
}
