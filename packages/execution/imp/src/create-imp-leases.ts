import type { makeKeyedLock } from '@atc/core';
import type { ImpHost } from './imp-host';
import type { ImpPort } from './imp-port';
import { ImpPortError } from './imp-port-error';

// The daemon's lease on each imp: its renewal while the imp is in use, and
// its return once nothing runs or starts there.
export interface ImpLeases {
  // The lease label of the daemon the provider serves, once a prepare
  // names it.
  label: string | null;

  // A renewal that finds the lease gone, as a forced sleep leaves it, stops
  // renewing: the daemon never takes a lease back behind an owner who ended
  // it. A host with no harness left gives its lease back.
  readonly startRenewal: (host: ImpHost, label: string) => void;

  readonly stopRenewal: (host: ImpHost) => void;

  readonly restoreLease: (host: ImpHost) => Promise<void>;

  // Gives an imp's lease back once nothing runs or starts there, in the
  // imp's turn, so it never drops a lease a readying took for a launch.
  readonly tryReleaseLease: (host: ImpHost) => Promise<boolean>;
}

interface ImpLeasesOptions {
  readonly port: ImpPort;
  readonly leaseSeconds: number;
  readonly withHostTurn: ReturnType<typeof makeKeyedLock>;
  readonly waitingPrepares: ReadonlyMap<string, number>;
}

export function createImpLeases(options: ImpLeasesOptions): ImpLeases {
  const port = options.port;
  const leaseSeconds = options.leaseSeconds;
  const withHostTurn = options.withHostTurn;
  const waitingPrepares = options.waitingPrepares;

  const tryRenewLease = async (host: ImpHost, label: string): Promise<boolean> => {
    try {
      await port.renewLease(host.name, label, leaseSeconds);
    } catch (error) {
      if (error instanceof ImpPortError && error.code === 'LEASE_NOT_HELD') {
        stopRenewal(host);
      }

      return false;
    }

    return true;
  };

  const tryReleaseLease = (host: ImpHost): Promise<boolean> =>
    withHostTurn(host.name, async () => {
      const isBusy =
        host.harnesses > 0 ||
        host.suspending ||
        (waitingPrepares.get(host.name) ?? 0) > 0 ||
        host.isIdle?.() === false;

      if (isBusy || self.label === null) {
        return false;
      }

      stopRenewal(host);

      try {
        return await port.releaseLease(host.name, self.label);
      } catch {
        return false;
      }
    });

  // A host with no harness gives its lease back, unless a launch readies it,
  // which keeps the lease renewed.
  const refreshLease = async (host: ImpHost, label: string): Promise<void> => {
    if (host.harnesses === 0) {
      const released = await tryReleaseLease(host);

      if (released) {
        return;
      }
    }

    if (host.renewTimer !== null) {
      await tryRenewLease(host, label);
    }
  };

  const startRenewal = (host: ImpHost, label: string): void => {
    if (host.renewTimer !== null) {
      return;
    }

    host.renewTimer = setInterval(
      () => {
        void refreshLease(host, label);
      },
      (leaseSeconds * 1000) / 3,
    );

    host.renewTimer.unref();
  };

  const self: ImpLeases = {
    label: null,

    startRenewal,

    stopRenewal,

    restoreLease: async (host) => {
      if (self.label === null) {
        return;
      }

      try {
        await port.acquireLease(host.name, self.label, leaseSeconds);
      } catch {
        return;
      }

      startRenewal(host, self.label);
    },

    tryReleaseLease,
  };

  return self;
}

function stopRenewal(host: ImpHost): void {
  if (host.renewTimer !== null) {
    clearInterval(host.renewTimer);

    host.renewTimer = null;
  }
}
