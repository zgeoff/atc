import type { Clock, SessionID } from '@atc/core';
import type { StateStore } from '@atc/store';
import type { SessionRuntime } from '../sessions/session-runtime';
import type { SessionManager } from '../sessions/sessions';
import { restoreFleet } from './restore-fleet';
import type { RestoreSettled } from './restore-fleet';

export interface FleetRestorer {
  // Resolves with the count of sessions the restore registered, before
  // their terminals finish booting.
  readonly runFleetRestore: (cols: number, rows: number) => Promise<number>;

  // the stored fleet restores once per start, at the size a restored terminal takes
  // until its first attach resizes it; a failure is logged and never stops the daemon
  readonly startBootRestore: (enabled: boolean) => Promise<void>;
}

interface FleetRestorerDeps {
  readonly manager: SessionManager;
  readonly store: StateStore;
  readonly clock: Clock;
  readonly findRuntime: (sessionID: SessionID) => SessionRuntime | undefined;

  // The longest a restored session's boot holds up the next one.
  readonly capMs: number;

  // The waits before each retry of a refused restore; the restore's own
  // when unset.
  readonly retryDelaysMs?: readonly number[] | undefined;

  // Whether the daemon has stopped, so a restore starts nothing more.
  readonly isStopped: () => boolean;

  // Called once each restore's staggered terminal adoption settles.
  readonly onRestoreSettled?: ((settled: RestoreSettled) => void) | undefined;

  // Called when the daemon starts without restoring the stored fleet.
  readonly onRestoreSkipped?: ((reason: 'disabled' | 'empty') => void) | undefined;
}

export function createFleetRestorer(deps: FleetRestorerDeps): FleetRestorer {
  let inFlight: Promise<number> | null = null;

  const runFleetRestore = (cols: number, rows: number): Promise<number> => {
    // a restore runs until its staggered terminal adoption settles, and one requested
    // meanwhile joins it, so the fleet never registers twice at once
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
