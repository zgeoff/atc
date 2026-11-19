import type { ImpdOutput } from '../impd/impd-procedure';
import type { ImpLease } from '../port/imp-port';

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
