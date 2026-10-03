import { DaemonError } from '../protocol/daemon-error';
import { buildRuledValue } from './build-ruled-value';
import { ERROR_DATA_RULES } from './id-rules';
import type { RegistryDaemon } from './types';

/**
 * A daemon's error as the gateway returns it: the same code, every id in
 * its `data` rewritten for the daemon, and every daemon id its message
 * quotes, from the data or from the request, replaced by its gateway id.
 * `requestIDs` maps each daemon id the request carried to the gateway id
 * the caller sent.
 */
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
