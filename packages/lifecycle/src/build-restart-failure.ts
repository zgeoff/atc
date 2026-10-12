import type { RestartResult } from './parse-restart-result';

/**
 * The result of a restart that stopped with `error` before it could count
 * the fleet. `interrupted` lists the sessions the stop already ended.
 */
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
