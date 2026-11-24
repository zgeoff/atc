import type { ProcedureMeta } from '../daemon-contract/procedure-meta';
import type { GrantScope } from '../sessions/grant-scope';

export interface FleetProcedureMeta extends ProcedureMeta {
  readonly scope: GrantScope;
}
