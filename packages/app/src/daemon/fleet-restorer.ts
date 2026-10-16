import type { Clock, SessionID } from '@atc/core';
import type { StateStore } from '@atc/store';
import { restoreFleet } from './restore-fleet';
import type { RestoreSettled } from './restore-fleet';
import type { SessionRuntime } from './session-runtime';
import type { SessionManager } from './sessions';

interface FleetRestorerDeps {
  readonly mgr: SessionManager;
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

/**
 * Restores the stored fleet, by itself when the daemon starts with the
 * option set, or on request. A restore runs from its first call until its
 * staggered terminal adoption finishes, and a restore requested meanwhile
 * joins it, so the fleet never registers twice at once.
 */
export class FleetRestorer {
  private readonly deps: FleetRestorerDeps;

  private inFlight: Promise<number> | null = null;

  constructor(deps: FleetRestorerDeps) {
    this.deps = deps;
  }

  // Resolves with the count of sessions the restore registered, before
  // their terminals finish booting.
  runFleetRestore(cols: number, rows: number): Promise<number> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }

    const restored = Promise.withResolvers<number>();

    this.inFlight = restored.promise;

    void (async () => {
      try {
        const result = await restoreFleet({
          mgr: this.deps.mgr,
          store: this.deps.store,
          findRuntime: this.deps.findRuntime,
          cols,
          rows,
          capMs: this.deps.capMs,
          ...(this.deps.retryDelaysMs === undefined
            ? {}
            : { retryDelaysMs: this.deps.retryDelaysMs }),
          isStopped: this.deps.isStopped,
          clock: this.deps.clock,
        });

        restored.resolve(result.restored);

        const outcome = await result.settled;

        this.deps.onRestoreSettled?.({ restored: result.restored, outcome });
      } catch (error) {
        restored.reject(error);
        this.deps.onRestoreSettled?.({ restored: 0, outcome: 'failed' });
      } finally {
        this.inFlight = null;
      }
    })();

    return restored.promise;
  }

  // The stored fleet restores once per start, at the size a restored
  // terminal takes until its first attach resizes it, and only when the
  // option is set and the store holds a fleet. A failure is logged and
  // never stops the daemon.
  async startBootRestore(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.deps.onRestoreSkipped?.('disabled');

      return;
    }

    const stored = await this.deps.store.loadFleet();

    if (stored.length === 0) {
      this.deps.onRestoreSkipped?.('empty');

      return;
    }

    void this.tryRunFleetRestore();
  }

  private async tryRunFleetRestore(): Promise<void> {
    try {
      await this.runFleetRestore(80, 24);
    } catch (error) {
      this.deps.mgr.log(
        `atc could not restore the fleet (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
}
