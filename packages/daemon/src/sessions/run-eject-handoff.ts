import { systemClock } from '@atc/core';
import type { SessionID } from '@atcx/contract';
import type { SessionRuntime } from './create-session-runtime';

export type SettleScheduler = (onTimeout: () => void, delayMs: number) => () => void;

interface EjectHandoffParams {
  readonly sessionID: SessionID;
  readonly prompt: string;
  readonly settleMs: number;
  readonly runtime: SessionRuntime;
  readonly startHeadlessTurn: (sessionID: SessionID, prompt: string) => boolean;

  // Starts the settle timer; the wall clock's timers when unset.
  readonly scheduleSettle?: SettleScheduler | undefined;
}

export function runEjectHandoff(params: EjectHandoffParams): void {
  const settled = Promise.withResolvers<void>();
  const scheduleSettle = params.scheduleSettle ?? systemClock.schedule;
  const cancelSettle = scheduleSettle(settled.resolve, params.settleMs);

  params.runtime.pendingEject = settled.resolve;

  void (async () => {
    // resuming an agent session while its old process still shuts down corrupts the handoff, so
    // the turn waits for the final report or the settle timeout
    await settled.promise;

    cancelSettle();

    params.runtime.pendingEject = null;

    params.startHeadlessTurn(params.sessionID, params.prompt);
  })();
}
