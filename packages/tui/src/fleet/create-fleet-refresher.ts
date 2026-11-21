import type { DaemonClient } from '@atc/protocol/client';
import type { FleetMirror } from './create-fleet-mirror';

export interface FleetRefresherDeps {
  readonly mirror: Pick<FleetMirror, 'refreshFleet'>;
  readonly readClient: () => Pick<DaemonClient, 'sendRequest'>;
  readonly onRefreshed: () => void;
}

export interface FleetRefresher {
  readonly refresh: () => void;
}

// Reads the primary daemon's fleet again. A request during a read runs one more read after it, so
// an older answer never lands over a newer one.
export function createFleetRefresher(deps: FleetRefresherDeps): FleetRefresher {
  let isReading = false;
  let isAskedAgain = false;

  const readUntilSettled = async () => {
    try {
      do {
        isAskedAgain = false;

        await deps.mirror.refreshFleet(deps.readClient());

        deps.onRefreshed();
      } while (isAskedAgain);
    } catch {
      // no connection yet; the next connect reads the fleet with the session list
    } finally {
      isReading = false;
    }
  };

  return {
    refresh: () => {
      if (isReading) {
        isAskedAgain = true;

        return;
      }

      isReading = true;
      void readUntilSettled();
    },
  };
}
