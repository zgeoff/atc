import { isRecord } from '@atc/core';
import { buildRuledValue } from './build-ruled-value';
import { ID_RULES } from './id-rules';
import type { RegistryDaemon } from './types';

export function buildGatewayResult(
  method: string,
  result: Readonly<Record<string, unknown>>,
  daemon: Pick<RegistryDaemon, 'name' | 'incarnation'>,
): Readonly<Record<string, unknown>> {
  if (method === 'events.read') {
    throw new Error('an events.read answer is rewritten by the event merge');
  }

  const rules = ID_RULES[method];

  if (rules === undefined) {
    throw new Error(`the gateway has no id rules for ${method}`);
  }

  const rewritten = buildRuledValue(result, rules, daemon);

  return isRecord(rewritten) ? rewritten : result;
}
