import { oc } from '@orpc/contract';
import type { ProcedureMeta } from '../daemon-contract/procedure-meta';
import { FLEET_ERROR_MAP } from './fleet-error-map';
import type { FleetProcedureMeta } from './fleet-procedure-meta';
import { FLEET_PROCEDURE_SCOPES } from './fleet-procedure-scopes';
import type { FleetProcedureName } from './fleet-procedure-scopes';

const DEFAULT_META: FleetProcedureMeta = {
  access: 'principal',
  readOnly: false,
  keyed: false,
  scope: 'read',
};

export const FLEET_BASE = oc.$meta<FleetProcedureMeta>(DEFAULT_META).errors(FLEET_ERROR_MAP);

interface DaemonProcedure {
  readonly '~orpc': { readonly meta: ProcedureMeta };
}

// A fleet procedure takes its access, readOnly and keyed from the daemon procedure it fronts.
export function buildFleetMeta(
  daemon: DaemonProcedure,
  name: FleetProcedureName,
): FleetProcedureMeta {
  const meta = daemon['~orpc'].meta;

  return {
    access: meta.access,
    readOnly: meta.readOnly,
    keyed: meta.keyed,
    scope: FLEET_PROCEDURE_SCOPES[name],
  };
}
