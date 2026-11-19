import { toImpLease } from '../client/to-imp-lease';
import { buildImpdRefusal } from '../impd/build-impd-refusal';
import type { ImpdBareRefusalCode, ImpdOutput } from '../impd/impd-procedure';
import type { ImpLease } from '../port/imp-port';
import { ImpPortError } from '../port/imp-port-error';
import { buildImpdLease } from './build-impd-lease';
import { buildNotFound } from './build-not-found';
import type { StubImpFleet } from './create-stub-imp-fleet';

export interface StubImpLeases {
  readonly acquireLease: (name: string, label: string, ttlSeconds: number) => Promise<ImpLease>;
  readonly renewLease: (name: string, label: string, ttlSeconds: number) => Promise<ImpLease>;
  readonly releaseLease: (name: string, label: string) => Promise<boolean>;
  readonly acquireOtherLease: (
    name: string,
    principal: string,
    label: string,
    ttlSeconds: number,
  ) => void;

  readonly setAcquireFailure: (skip: number, code: ImpdBareRefusalCode<'leases.acquire'>) => void;

  readonly subscribeToLeaseAcquires: (
    listener: (name: string, label: string) => void,
  ) => () => void;

  readonly startLeaseHold: () => void;

  readonly countHeldLeases: () => number;

  readonly stopLeaseHold: () => void;
  readonly startReleaseHold: () => void;

  readonly countHeldReleases: () => number;

  readonly stopReleaseHold: () => void;
}

interface StubImpLeasesOptions {
  readonly calls: string[];
  readonly fleet: StubImpFleet;
}

export function createStubImpLeases(deps: StubImpLeasesOptions): StubImpLeases {
  let acquireFailure: {
    skip: number;
    readonly code: ImpdBareRefusalCode<'leases.acquire'>;
  } | null = null;

  let releaseHold: PromiseWithResolvers<void> | null = null;
  let leaseHold: PromiseWithResolvers<void> | null = null;
  let heldLeases = 0;
  let heldReleases = 0;

  const leaseAcquireListeners = new Set<(name: string, label: string) => void>();

  const calls = deps.calls;
  const fleet = deps.fleet;

  const applyLease = (name: string, label: string, ttlSeconds: number): Promise<ImpLease> => {
    const failure = acquireFailure;

    if (failure !== null) {
      if (failure.skip === 0) {
        acquireFailure = null;

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

    const imp = fleet.imps.get(name);

    if (imp === undefined) {
      return Promise.reject(buildNotFound('leases.acquire', name));
    }

    fleet.updateAwake(imp);

    const principal = fleet.principal;
    const until = fleet.now() + ttlSeconds * 1000;

    imp.leases.set(`${principal}\u0000${label}`, { principal, label, until });

    return Promise.resolve(toImpLease(buildImpdLease(name, principal, label, until)));
  };

  const waitForLease = async (
    name: string,
    label: string,
    ttlSeconds: number,
  ): Promise<ImpLease> => {
    heldLeases += 1;

    await leaseHold?.promise;

    heldLeases -= 1;

    return applyLease(name, label, ttlSeconds);
  };

  const applyRelease = (name: string, label: string): Promise<boolean> => {
    const imp = fleet.imps.get(name);

    if (imp === undefined) {
      return Promise.reject(buildNotFound('leases.release', name));
    }

    const released: ImpdOutput<'leases.release'> = {
      released: imp.leases.delete(`${fleet.principal}\u0000${label}`),
    };

    return Promise.resolve(released.released);
  };

  const waitForRelease = async (name: string, label: string): Promise<boolean> => {
    heldReleases += 1;

    await releaseHold?.promise;

    heldReleases -= 1;

    return applyRelease(name, label);
  };

  return {
    acquireLease: (name, label, ttlSeconds) => {
      calls.push(`leases.acquire ${name} ${label}`);

      for (const listener of leaseAcquireListeners) {
        listener(name, label);
      }

      return leaseHold === null
        ? applyLease(name, label, ttlSeconds)
        : waitForLease(name, label, ttlSeconds);
    },

    renewLease: (name, label, ttlSeconds) => {
      calls.push(`leases.renew ${name} ${label}`);

      const principal = fleet.principal;
      const imp = fleet.imps.get(name);
      const key = `${principal}\u0000${label}`;
      const lease = imp?.leases.get(key);

      if (imp === undefined || lease === undefined || lease.until <= fleet.now()) {
        return Promise.reject(
          buildImpdRefusal(
            'leases.renew',
            { code: 'LEASE_NOT_HELD' },
            'the caller holds no such lease',
          ),
        );
      }

      const until = fleet.now() + ttlSeconds * 1000;

      imp.leases.set(key, { ...lease, until });

      return Promise.resolve(toImpLease(buildImpdLease(name, principal, label, until)));
    },

    releaseLease: (name, label) => {
      calls.push(`leases.release ${name} ${label}`);

      return releaseHold === null ? applyRelease(name, label) : waitForRelease(name, label);
    },

    acquireOtherLease: (name, principal, label, ttlSeconds) => {
      const imp = fleet.getImp(name);

      imp.leases.set(`${principal}\u0000${label}`, {
        principal,
        label,
        until: fleet.now() + ttlSeconds * 1000,
      });
    },

    setAcquireFailure: (skip, code) => {
      acquireFailure = { skip, code };
    },

    subscribeToLeaseAcquires: (listener) => {
      leaseAcquireListeners.add(listener);

      return () => {
        leaseAcquireListeners.delete(listener);
      };
    },

    startLeaseHold: () => {
      leaseHold ??= Promise.withResolvers<void>();
    },

    countHeldLeases: () => heldLeases,

    stopLeaseHold: () => {
      leaseHold?.resolve();
      leaseHold = null;
    },

    startReleaseHold: () => {
      releaseHold ??= Promise.withResolvers<void>();
    },

    countHeldReleases: () => heldReleases,

    stopReleaseHold: () => {
      releaseHold?.resolve();
      releaseHold = null;
    },
  };
}
