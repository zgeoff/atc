import type { SessionID } from '../shared/session-id';
import type { SessionRuntime } from './session-runtime';

/**
 * Starts a timer that runs `onTimeout` after `ms` milliseconds, returning
 * what cancels it.
 */
export type SettleScheduler = (onTimeout: () => void, ms: number) => () => void;

export interface EjectHandoffParams {
  readonly sessionID: SessionID;
  readonly prompt: string;
  readonly settleMs: number;
  readonly runtime: SessionRuntime;
  readonly startHeadlessTurn: (sessionID: SessionID, prompt: string) => boolean;

  // Starts the settle timer; defaults to a real `setTimeout`.
  readonly scheduleSettle?: SettleScheduler | undefined;
}

/**
 * Waits for the ejected terminal's final report (or a settle timeout,
 * whichever comes first) before starting the headless turn — resuming an
 * agent session while its old process is still shutting down corrupts the
 * handoff.
 */
export function runEjectHandoff(params: EjectHandoffParams): void {
  const settled = Promise.withResolvers<void>();
  const scheduleSettle = params.scheduleSettle ?? scheduleRealSettle;
  const cancelSettle = scheduleSettle(settled.resolve, params.settleMs);

  params.runtime.pendingEject = settled.resolve;

  void (async () => {
    await settled.promise;

    cancelSettle();

    params.runtime.pendingEject = null;

    params.startHeadlessTurn(params.sessionID, params.prompt);
  })();
}

function scheduleRealSettle(onTimeout: () => void, ms: number): () => void {
  const timer = setTimeout(onTimeout, ms);

  return () => {
    clearTimeout(timer);
  };
}
