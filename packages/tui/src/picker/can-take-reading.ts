import type { SourceEntry, SourceInterpretation } from '@atcx/contract';

export function canTakeReading(
  kind: SourceEntry['kind'] | undefined,
  reading: SourceInterpretation,
): boolean {
  return reading.kind === 'browse' || (reading.kind !== 'none' && reading.kind === kind);
}
