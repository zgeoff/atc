import type { ImpdLease } from '../to-imp-lease';

export function buildImpdLease(
  name: string,
  principal: string,
  label: string,
  until: number,
): ImpdLease {
  return { name, owner: { principal, display: principal, label }, until: new Date(until) };
}
