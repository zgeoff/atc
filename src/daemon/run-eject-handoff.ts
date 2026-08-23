import type { SessionID } from '../shared/session-id';
import type { SessionRuntime } from './session-runtime';

export interface EjectHandoffParams {
  readonly sessionID: SessionID;
  readonly prompt: string;
  readonly settleMs: number;
  readonly runtime: SessionRuntime;
  readonly startHeadlessTurn: (sessionID: SessionID, prompt: string) => boolean;
}

/**
 * Waits for the ejected terminal's final report (or a settle timeout,
 * whichever comes first) before starting the headless turn — resuming an
 * agent session while its old process is still shutting down corrupts the
 * handoff.
 */
export function runEjectHandoff(params: EjectHandoffParams): void {
  const settled = Promise.withResolvers<void>();
  const timer = setTimeout(settled.resolve, params.settleMs);

  params.runtime.pendingEject = settled.resolve;

  void (async () => {
    await settled.promise;

    clearTimeout(timer);

    params.runtime.pendingEject = null;

    params.startHeadlessTurn(params.sessionID, params.prompt);
  })();
}
