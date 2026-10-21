import type { RestartResult } from '@atc/protocol';

export function buildRestartFailure(
  runID: string,
  error: string,
  interrupted: RestartResult['interrupted'] = [],
): RestartResult {
  return {
    runID,
    code: 1,
    pid: null,
    build: null,
    listenPort: null,
    restored: 0,
    total: 0,
    failed: [],
    interrupted,
    error,
  };
}
