import type { Clock } from '@atc/core';
import type { StateStore } from '@atc/store';
import type { SessionID } from '@atcx/contract';
import type { SessionManager } from '../sessions/create-session-manager';
import type { SessionRuntime } from '../sessions/create-session-runtime';
import { restoreFleet } from './restore-fleet';
import type { RestoreSettled } from './restore-fleet';

export interface FleetRestorer {
  readonly runFleetRestore: (cols: number, rows: number) => Promise<number>;

  readonly startBootRestore: (enabled: boolean) => Promise<void>;
}

interface FleetRestorerDeps {
  readonly manager: SessionManager;
  readonly store: StateStore;
  readonly clock: Clock;
  readonly findRuntime: (sessionID: SessionID) => SessionRuntime | undefined;

  readonly capMs: number;

  readonly retryDelaysMs?: readonly number[] | undefined;

  readonly isStopped: () => boolean;

  readonly onRestoreSettled?: ((settled: RestoreSettled) => void) | undefined;

  readonly onRestoreSkipped?: ((reason: 'disabled' | 'empty') => void) | undefined;
}

export function createFleetRestorer(deps: FleetRestorerDeps): FleetRestorer {
  let inFlight: Promise<number> | null = null;

  const runFleetRestore = (cols: number, rows: number): Promise<number> => {
    if (inFlight !== null) {
      return inFlight;
    }

    const restored = Promise.withResolvers<number>();

    inFlight = restored.promise;

    void (async () => {
      try {
        const result = await restoreFleet({
          manager: deps.manager,
          store: deps.store,
          findRuntime: deps.findRuntime,
          cols,
          rows,
          capMs: deps.capMs,
          ...(deps.retryDelaysMs === undefined ? {} : { retryDelaysMs: deps.retryDelaysMs }),
          isStopped: deps.isStopped,
          clock: deps.clock,
        });

        restored.resolve(result.restored);

        const outcome = await result.settled;

        deps.onRestoreSettled?.({ restored: result.restored, outcome });
      } catch (error) {
        restored.reject(error);
        deps.onRestoreSettled?.({ restored: 0, outcome: 'failed' });
      } finally {
        inFlight = null;
      }
    })();

    return restored.promise;
  };

  const logRestoreFailure = (error: unknown): void => {
    deps.manager.log(
      `atc could not restore the fleet (${error instanceof Error ? error.message : String(error)})`,
    );
  };

  const tryRunFleetRestore = async (): Promise<void> => {
    try {
      await runFleetRestore(80, 24);
    } catch (error) {
      logRestoreFailure(error);
    }
  };

  return {
    runFleetRestore,

    startBootRestore: async (enabled) => {
      if (!enabled) {
        deps.onRestoreSkipped?.('disabled');

        return;
      }

      let stored;

      try {
        stored = await deps.store.loadFleet();
      } catch (error) {
        logRestoreFailure(error);

        return;
      }

      if (stored.length === 0) {
        deps.onRestoreSkipped?.('empty');

        return;
      }

      void tryRunFleetRestore();
    },
  };
}
