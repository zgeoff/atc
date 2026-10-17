import type { ImpLease } from './imp-port';
import type { ImpdOutput } from './impd-contract';

export type ImpdLease = ImpdOutput<'leases.acquire'>;

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
