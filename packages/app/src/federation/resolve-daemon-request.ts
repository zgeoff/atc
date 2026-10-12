import { DaemonError } from '../protocol/daemon-error';
import { parseGatewayID } from './parse-gateway-id';
import type { GatewayRegistry, RegistryDaemon } from './types';

// The request params that hold a gateway id, and the refusal a daemon
// gives for an id it does not hold, which the gateway gives for an id that
// routes nowhere.
const ID_PARAMS: readonly (readonly [string, 'session' | 'message' | 'note'])[] = [
  ['session', 'session'],
  ['parent', 'session'],
  ['message', 'message'],
  ['note', 'note'],
];

/**
 * A daemon request's route: the daemon its id params point at, or null
 * for a request with none; the params with each gateway id replaced by the
 * daemon's own id; and each daemon id mapped back to the gateway id the
 * caller sent, for errors that quote it. An id that is malformed, holds
 * an unknown name or a stale incarnation, or points at another daemon than
 * the request's other ids gets the refusal a daemon gives for an id it
 * never held.
 */
export function resolveDaemonRequest(
  params: Readonly<Record<string, unknown>>,
  registry: GatewayRegistry,
): {
  readonly daemon: RegistryDaemon | null;
  readonly params: Readonly<Record<string, unknown>>;
  readonly requestIDs: ReadonlyMap<string, string>;
} {
  let daemon: RegistryDaemon | null = null;
  const rewritten: Record<string, unknown> = { ...params };

  const requestIDs = new Map<string, string>();

  for (const [field, kind] of ID_PARAMS) {
    const value = params[field];

    if (typeof value !== 'string') {
      continue;
    }

    const parsed = parseGatewayID(value, registry);

    if (parsed === null || (daemon !== null && parsed.daemon !== daemon)) {
      throw kind === 'session'
        ? new DaemonError('no_such_session', `no session '${value}'`)
        : new DaemonError('bad_args', `no ${kind} '${value}'`);
    }

    daemon = parsed.daemon;
    rewritten[field] = parsed.id;

    requestIDs.set(parsed.id, value);
  }

  return { daemon, params: rewritten, requestIDs };
}
