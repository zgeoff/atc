import { isRecord } from '@atc/core';
import { isContractProcedure } from '@orpc/contract';
import { DAEMON_CONTRACT } from './daemon-contract';
import { PROCEDURE_META_SCHEMA } from './procedure-meta';
import type { ProcedureMeta } from './procedure-meta';

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
