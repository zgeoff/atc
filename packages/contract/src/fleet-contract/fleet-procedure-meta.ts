import { z } from 'zod';
import { PROCEDURE_META_SCHEMA } from '../daemon-contract/procedure-meta';
import type { ProcedureMeta } from '../daemon-contract/procedure-meta';
import { GRANT_SCOPES } from '../sessions/grant-scope';
import type { GrantScope } from '../sessions/grant-scope';

export const FLEET_PROCEDURE_META_SCHEMA = PROCEDURE_META_SCHEMA.extend({
  scope: z.enum(GRANT_SCOPES),
});

export interface FleetProcedureMeta extends ProcedureMeta {
  readonly scope: GrantScope;
}
