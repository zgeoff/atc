import type { SourceEntry, SourceInterpretation } from '@atc/protocol';

export function canTakeReading(
  kind: SourceEntry['kind'] | undefined,
  reading: SourceInterpretation,
): boolean {
  return reading.kind === 'browse' || (reading.kind !== 'none' && reading.kind === kind);
}
