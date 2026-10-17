import { buildImpdRefusal } from '../build-impd-refusal';
import type { ImpPortError } from '../imp-port-error';

// The procedures the stand-in answers on an imp it may not hold.
type StubImpProcedure =
  | 'exec.ticket'
  | 'files.write'
  | 'grants.add'
  | 'grants.list'
  | 'imps.destroy'
  | 'imps.sleep'
  | 'leases.acquire'
  | 'leases.release';

// impd's refusal of a call on an imp it does not hold. The
// procedure only types the refusal.
export function buildNotFound(procedure: StubImpProcedure, name: string): ImpPortError {
  return buildImpdRefusal(
    procedure,
    { code: 'NOT_FOUND', data: { kind: 'imp', name } },
    `no imp ${name}`,
  );
}
