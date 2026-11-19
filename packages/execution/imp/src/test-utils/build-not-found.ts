import { buildImpdRefusal } from '../impd/build-impd-refusal';
import type { ImpPortError } from '../port/imp-port-error';

type StubImpProcedure =
  | 'exec.ticket'
  | 'files.write'
  | 'grants.add'
  | 'grants.list'
  | 'imps.destroy'
  | 'imps.sleep'
  | 'leases.acquire'
  | 'leases.release';

export function buildNotFound(procedure: StubImpProcedure, name: string): ImpPortError {
  return buildImpdRefusal(
    procedure,
    { code: 'NOT_FOUND', data: { kind: 'imp', name } },
    `no imp ${name}`,
  );
}
