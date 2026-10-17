import { DaemonError } from '@atc/protocol/wire';
import { buildRuledValue } from './build-ruled-value';
import { ERROR_DATA_RULES } from './id-rules';
import type { RegistryDaemon } from './types';

export function buildGatewayError(
  error: Readonly<DaemonError>,
  daemon: Pick<RegistryDaemon, 'name' | 'incarnation'>,
  requestIDs: ReadonlyMap<string, string>,
): DaemonError {
  if (error.data === undefined) {
    return new DaemonError(error.code, buildQuotedMessage(error.message, requestIDs));
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

  return new DaemonError(error.code, buildQuotedMessage(error.message, quoted), data);
}

// The message with each quoted daemon id replaced, longest first so an id
// that contains another is replaced whole.
function buildQuotedMessage(message: string, ids: ReadonlyMap<string, string>): string {
  const ordered = [...ids].toSorted(([a], [b]) => b.length - a.length);

  return ordered.reduce((text, [inner, outer]) => text.replaceAll(inner, outer), message);
}
