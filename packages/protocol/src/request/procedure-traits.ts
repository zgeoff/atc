import { isRecord } from '@atc/core';
import { DAEMON_CONTRACT, PROCEDURE_META_SCHEMA } from '@atcx/contract';
import type { ProcedureMeta } from '@atcx/contract';
import { isContractProcedure } from '@orpc/contract';

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
