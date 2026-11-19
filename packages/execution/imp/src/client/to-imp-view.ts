import type { ImpdOutput } from '../impd/impd-procedure';
import type { ImpView } from '../port/imp-port';
import { toImpLease } from './to-imp-lease';

export function toImpView(
  imp: Pick<ImpdOutput<'imps.get'>, 'id' | 'name' | 'state' | 'leases'>,
): ImpView {
  return {
    id: imp.id,
    name: imp.name,
    state: imp.state,
    leases: (imp.leases?.leases ?? []).map((lease) => toImpLease(lease)),
    otherLeaseCount: imp.leases?.otherCount ?? 0,
  };
}
