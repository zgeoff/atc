import type { MaterializationPhase } from '@atc/store';
import { DaemonError } from '@atcx/contract/client';
import type { ErrorCode } from '@atcx/contract/light';

// A refusal holds the phase it failed in; one raised without a phase, such
// as a git whose output stays open, takes the phase it was raised in.
export function toDaemonError(
  error: unknown,
  code: ErrorCode,
  phase: MaterializationPhase,
): DaemonError {
  if (error instanceof DaemonError) {
    return error.data?.['phase'] === undefined
      ? new DaemonError(error.code, error.message, { ...error.data, phase })
      : error;
  }

  const reason = error instanceof Error ? error.message : String(error);

  return new DaemonError(code, reason, { phase });
}
