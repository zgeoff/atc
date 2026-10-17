import type { ImpLease } from './imp-port';
import type { ImpdOutput } from './impd-contract';

/**
 * A lease as impd returns it, which a refusal of a sleep lists too.
 */
export type ImpdLease = ImpdOutput<'leases.acquire'>;

/**
 * A lease in the port's terms, its end in epoch milliseconds.
 */
export function toImpLease(lease: ImpdLease): ImpLease {
  return {
    name: lease.name,
    owner: {
      principal: lease.owner.principal,
      display: lease.owner.display,
      label: lease.owner.label,
    },
    until: lease.until?.getTime() ?? null,
  };
}
