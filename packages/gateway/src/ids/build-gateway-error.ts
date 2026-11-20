import { AtcError } from '@atcx/contract/light';
import type { RegistryDaemon } from '../types';
import { buildRuledValue } from './build-ruled-value';
import { ERROR_DATA_RULES } from './id-rules';

export function buildGatewayError(
  error: Readonly<AtcError>,
  daemon: Pick<RegistryDaemon, 'name' | 'incarnation'>,
  requestIDs: ReadonlyMap<string, string>,
): AtcError {
  if (Object.keys(error.data).length === 0) {
    return new AtcError(error.code, buildQuotedMessage(error.message, requestIDs));
  }

  const rewritten = buildRuledValue(error.data, ERROR_DATA_RULES, daemon);
  const data = typeof rewritten === 'object' && rewritten !== null ? { ...rewritten } : error.data;

  const quoted = new Map(requestIDs);

  for (const field of ERROR_DATA_RULES.keys()) {
    const inner = error.data[field];
    const outer = Reflect.get(data, field);

    if (typeof inner === 'string' && typeof outer === 'string') {
      quoted.set(inner, outer);
    }
  }

  return new AtcError(error.code, buildQuotedMessage(error.message, quoted), data);
}

function buildQuotedMessage(message: string, ids: ReadonlyMap<string, string>): string {
  const ordered = [...ids].toSorted(([leftID], [rightID]) => rightID.length - leftID.length);

  return ordered.reduce((text, [inner, outer]) => text.replaceAll(inner, outer), message);
}
