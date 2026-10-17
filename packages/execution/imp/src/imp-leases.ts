import type { makeKeyedLock } from '@atc/core';
import type { ImpHost } from './imp-host';
import type { ImpPort } from './imp-port';
import { ImpPortError } from './imp-port-error';

interface ImpLeasesOptions {
  readonly port: ImpPort;
  readonly leaseSeconds: number;
  readonly withHostTurn: ReturnType<typeof makeKeyedLock>;
  readonly waitingPrepares: ReadonlyMap<string, number>;
}

// The daemon's lease on each imp: its renewal while the imp is in use, and
// its return once nothing runs or starts there.
export class ImpLeases {
  // The lease label of the daemon the provider serves, once a prepare
  // names it.
  label: string | null = null;

  private readonly port: ImpPort;

  private readonly leaseSeconds: number;

  private readonly withHostTurn: ReturnType<typeof makeKeyedLock>;

  private readonly waitingPrepares: ReadonlyMap<string, number>;

  constructor(options: ImpLeasesOptions) {
    this.port = options.port;
    this.leaseSeconds = options.leaseSeconds;
    this.withHostTurn = options.withHostTurn;
    this.waitingPrepares = options.waitingPrepares;
  }

  // A renewal that finds the lease gone, as a forced sleep leaves it, stops
  // renewing: the daemon never takes a lease back behind an owner who ended
  // it. A host with no harness left gives its lease back.
  startRenewal(host: ImpHost, label: string): void {
    if (host.renewTimer !== null) {
      return;
    }

    host.renewTimer = setInterval(
      () => {
        void this.refreshLease(host, label);
      },
      (this.leaseSeconds * 1000) / 3,
    );

    host.renewTimer.unref();
  }

  private async tryRenewLease(host: ImpHost, label: string): Promise<boolean> {
    try {
      await this.port.renewLease(host.name, label, this.leaseSeconds);
    } catch (error) {
      if (error instanceof ImpPortError && error.code === 'LEASE_NOT_HELD') {
        this.stopRenewal(host);
      }

      return false;
    }

    return true;
  }

  stopRenewal(host: ImpHost): void {
    if (host.renewTimer !== null) {
      clearInterval(host.renewTimer);

      host.renewTimer = null;
    }
  }

  async restoreLease(host: ImpHost): Promise<void> {
    if (this.label === null) {
      return;
    }

    try {
      await this.port.acquireLease(host.name, this.label, this.leaseSeconds);
    } catch {
      return;
    }

    this.startRenewal(host, this.label);
  }

  // A host with no harness gives its lease back, unless a launch readies it,
  // which keeps the lease renewed.
  private async refreshLease(host: ImpHost, label: string): Promise<void> {
    if (host.harnesses === 0) {
      const released = await this.tryReleaseLease(host);

      if (released) {
        return;
      }
    }

    if (host.renewTimer !== null) {
      await this.tryRenewLease(host, label);
    }
  }

  // Gives an imp's lease back once nothing runs or starts there, in the
  // imp's turn, so it never drops a lease a readying took for a launch.
  tryReleaseLease(host: ImpHost): Promise<boolean> {
    return this.withHostTurn(host.name, async () => {
      const isBusy =
        host.harnesses > 0 ||
        host.suspending ||
        (this.waitingPrepares.get(host.name) ?? 0) > 0 ||
        host.isIdle?.() === false;

      if (isBusy || this.label === null) {
        return false;
      }

      this.stopRenewal(host);

      try {
        return await this.port.releaseLease(host.name, this.label);
      } catch {
        return false;
      }
    });
  }
}
