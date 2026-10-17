import { isRecord } from '@atc/core';
import { isContractProcedure } from '@orpc/contract';
import { z } from 'zod';
import { DAEMON_CONTRACT } from './daemon-contract';

export function findAnswerSchema(method: string): z.ZodType | null {
  let node: unknown = DAEMON_CONTRACT;

  for (const key of method.split('.')) {
    if (!isRecord(node) || !Object.hasOwn(node, key)) {
      return null;
    }

    node = node[key];
  }

  if (!isContractProcedure(node)) {
    return null;
  }

  const schema: unknown = node['~orpc'].outputSchema;

  return schema instanceof z.ZodType ? schema : null;
}
