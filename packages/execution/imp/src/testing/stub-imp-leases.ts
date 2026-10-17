import { buildImpdRefusal } from '../build-impd-refusal';
import type { ImpLease } from '../imp-port';
import { ImpPortError } from '../imp-port-error';
import type { ImpdBareRefusalCode, ImpdOutput } from '../impd-contract';
import { toImpLease } from '../to-imp-lease';
import { buildImpdLease } from './build-impd-lease';
import { buildNotFound } from './build-not-found';
import type { StubImpFleet } from './stub-imp-fleet';

interface StubImpLeasesOptions {
  readonly calls: string[];
  readonly fleet: StubImpFleet;
}

// The leases that keep imps awake: their acquisition, renewal, and release,
// with the holds and failures a test puts in their way.
export class StubImpLeases {
  // Lease acquisitions that go through before the next one fails, and
  // impd's code for that failure, or null for none.
  private acquireFailure: {
    skip: number;
    readonly code: ImpdBareRefusalCode<'leases.acquire'>;
  } | null = null;

  // The lease releases wait for this hold to end, while one is held.
  private releaseHold: PromiseWithResolvers<void> | null = null;

  // The lease acquisitions wait for this hold to end, while one is held.
  private leaseHold: PromiseWithResolvers<void> | null = null;

  // How many lease acquisitions and releases wait on their holds.
  private heldLeases = 0;

  private heldReleases = 0;

  // Called at the start of every lease acquisition, in the caller's turn.
  private readonly leaseAcquireListeners = new Set<(name: string, label: string) => void>();

  private readonly calls: string[];

  private readonly fleet: StubImpFleet;

  constructor(deps: StubImpLeasesOptions) {
    this.calls = deps.calls;
    this.fleet = deps.fleet;
  }

  acquireLease(name: string, label: string, ttlSeconds: number): Promise<ImpLease> {
    this.calls.push(`leases.acquire ${name} ${label}`);

    for (const listener of this.leaseAcquireListeners) {
      listener(name, label);
    }

    return this.leaseHold === null
      ? this.applyLease(name, label, ttlSeconds)
      : this.waitForLease(name, label, ttlSeconds);
  }

  renewLease(name: string, label: string, ttlSeconds: number): Promise<ImpLease> {
    this.calls.push(`leases.renew ${name} ${label}`);

    const principal = this.fleet.principal;
    const imp = this.fleet.imps.get(name);
    const key = `${principal}\u0000${label}`;
    const lease = imp?.leases.get(key);

    if (imp === undefined || lease === undefined || lease.until <= this.fleet.now()) {
      return Promise.reject(
        buildImpdRefusal(
          'leases.renew',
          { code: 'LEASE_NOT_HELD' },
          'the caller holds no such lease',
        ),
      );
    }

    const until = this.fleet.now() + ttlSeconds * 1000;

    imp.leases.set(key, { ...lease, until });

    return Promise.resolve(toImpLease(buildImpdLease(name, principal, label, until)));
  }

  releaseLease(name: string, label: string): Promise<boolean> {
    this.calls.push(`leases.release ${name} ${label}`);

    return this.releaseHold === null
      ? this.applyRelease(name, label)
      : this.waitForRelease(name, label);
  }

  acquireOtherLease(name: string, principal: string, label: string, ttlSeconds: number): void {
    const imp = this.fleet.getImp(name);

    imp.leases.set(`${principal}\u0000${label}`, {
      principal,
      label,
      until: this.fleet.now() + ttlSeconds * 1000,
    });
  }

  // Fails once skip more acquisitions have gone through.
  setAcquireFailure(skip: number, code: ImpdBareRefusalCode<'leases.acquire'>): void {
    this.acquireFailure = { skip, code };
  }

  // A listener runs before the acquisition returns or waits on a hold, so the
  // caller's turn has not yet ended.
  subscribeToLeaseAcquires(listener: (name: string, label: string) => void): () => void {
    this.leaseAcquireListeners.add(listener);

    return () => {
      this.leaseAcquireListeners.delete(listener);
    };
  }

  startLeaseHold(): void {
    this.leaseHold ??= Promise.withResolvers<void>();
  }

  // How many lease acquisitions wait for the lease hold to stop.
  countHeldLeases(): number {
    return this.heldLeases;
  }

  stopLeaseHold(): void {
    this.leaseHold?.resolve();
    this.leaseHold = null;
  }

  startReleaseHold(): void {
    this.releaseHold ??= Promise.withResolvers<void>();
  }

  // How many lease releases wait for the release hold to stop.
  countHeldReleases(): number {
    return this.heldReleases;
  }

  stopReleaseHold(): void {
    this.releaseHold?.resolve();
    this.releaseHold = null;
  }

  private async waitForLease(name: string, label: string, ttlSeconds: number): Promise<ImpLease> {
    this.heldLeases += 1;

    await this.leaseHold?.promise;

    this.heldLeases -= 1;

    return this.applyLease(name, label, ttlSeconds);
  }

  private applyLease(name: string, label: string, ttlSeconds: number): Promise<ImpLease> {
    const failure = this.acquireFailure;

    if (failure !== null) {
      if (failure.skip === 0) {
        this.acquireFailure = null;

        return Promise.reject(
          new ImpPortError(failure.code, `impd refused the lease (${failure.code})`),
        );
      }

      failure.skip -= 1;
    }

    if (label === 'hold' || ttlSeconds < 10 || ttlSeconds > 3600) {
      return Promise.reject(
        buildImpdRefusal(
          'leases.acquire',
          { code: 'BAD_REQUEST' },
          'the label or ttl is not allowed',
        ),
      );
    }

    const imp = this.fleet.imps.get(name);

    if (imp === undefined) {
      return Promise.reject(buildNotFound('leases.acquire', name));
    }

    this.fleet.updateAwake(imp);

    const principal = this.fleet.principal;
    const until = this.fleet.now() + ttlSeconds * 1000;

    imp.leases.set(`${principal}\u0000${label}`, { principal, label, until });

    return Promise.resolve(toImpLease(buildImpdLease(name, principal, label, until)));
  }

  private async waitForRelease(name: string, label: string): Promise<boolean> {
    this.heldReleases += 1;

    await this.releaseHold?.promise;

    this.heldReleases -= 1;

    return this.applyRelease(name, label);
  }

  private applyRelease(name: string, label: string): Promise<boolean> {
    const imp = this.fleet.imps.get(name);

    if (imp === undefined) {
      return Promise.reject(buildNotFound('leases.release', name));
    }

    const released: ImpdOutput<'leases.release'> = {
      released: imp.leases.delete(`${this.fleet.principal}\u0000${label}`),
    };

    return Promise.resolve(released.released);
  }
}
