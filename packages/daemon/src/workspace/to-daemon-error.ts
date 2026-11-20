import type { MaterializationPhase } from '@atc/store';
import { AtcError } from '@atcx/contract/light';
import type { ErrorCode } from '@atcx/contract/light';

export function toDaemonError(
  error: unknown,
  code: ErrorCode,
  phase: MaterializationPhase,
): AtcError {
  if (error instanceof AtcError) {
    return error.data?.['phase'] === undefined
      ? new AtcError(error.code, error.message, { ...error.data, phase })
      : error;
  }

  const reason = error instanceof Error ? error.message : String(error);

  return new AtcError(code, reason, { phase });
}
