import type { makeKeyedLock } from '@atc/core';
import type { ImpHost } from '../port/imp-host';
import type { ImpPort } from '../port/imp-port';
import { ImpPortError } from '../port/imp-port-error';

export interface ImpLeases {
  label: string | null;

  readonly startRenewal: (host: ImpHost, label: string) => void;

  readonly stopRenewal: (host: ImpHost) => void;

  readonly restoreLease: (host: ImpHost) => Promise<void>;

  // Runs in the imp's turn, so it never gives back a lease that a readying took for a launch.
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
      // A forced sleep removes the lease. Retaking it would override the owner who ended it.
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
