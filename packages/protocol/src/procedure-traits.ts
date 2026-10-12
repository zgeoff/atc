import { isRecord } from '@atc/core/is-record';
import { isContractProcedure } from '@orpc/contract';
import { DAEMON_CONTRACT } from './daemon-contract';
import { PROCEDURE_META_SCHEMA } from './procedure-meta';
import type { ProcedureMeta } from './procedure-meta';

/**
 * The traits of every daemon procedure, keyed by its request method: the
 * procedure's path in the contract joined with dots, such as
 * `session.auth.revoke`. A method the contract does not define has none.
 */
export const PROCEDURE_TRAITS: ReadonlyMap<string, ProcedureMeta> = new Map(
  collectProcedureTraits(DAEMON_CONTRACT, []),
);

function collectProcedureTraits(
  router: unknown,
  path: readonly string[],
): readonly (readonly [string, ProcedureMeta])[] {
  if (isContractProcedure(router)) {
    return [[path.join('.'), PROCEDURE_META_SCHEMA.parse(router['~orpc'].meta)]];
  }

  if (!isRecord(router)) {
    return [];
  }

  return Object.entries(router).flatMap(([key, child]) =>
    collectProcedureTraits(child, [...path, key]),
  );
}
