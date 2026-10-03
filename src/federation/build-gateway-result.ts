import { isRecord } from '../shared/report';
import { buildRuledValue } from './build-ruled-value';
import { ID_RULES } from './id-rules';
import type { RegistryDaemon } from './types';

/**
 * A daemon method's answer as the gateway returns it, every id field in
 * the method's rules rewritten for the daemon that answered. An
 * `events.read` answer goes through the event merge instead, which owns
 * its cursors.
 */
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
    return result;
  }

  const rewritten = buildRuledValue(result, rules, daemon);

  return isRecord(rewritten) ? rewritten : result;
}
