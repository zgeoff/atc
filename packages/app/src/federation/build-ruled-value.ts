import { isRecord } from '../shared/report';
import { buildGatewayID } from './build-gateway-id';
import type { IDRule } from './id-rules';
import type { RegistryDaemon } from './types';

type DaemonRef = Pick<RegistryDaemon, 'name' | 'incarnation'>;

/**
 * A daemon answer with every field a rule covers rewritten for the
 * gateway: ids carry the daemon's name and incarnation, and a locator's
 * daemon ID gives way to them. A `cursor` field is left for the event
 * merge, a `keep` object is still searched for ruled fields below it, and
 * an `opaque` value passes whole.
 * Fields without a rule pass unchanged.
 */
export function buildRuledValue(
  value: unknown,
  rules: ReadonlyMap<string, IDRule>,
  daemon: DaemonRef,
  path = '',
): unknown {
  const rule = rules.get(path);

  if (rule === 'opaque') {
    return value;
  }

  if (rule === 'id' && typeof value === 'string') {
    return buildGatewayID(daemon, value);
  }

  if (rule === 'locator' && isRecord(value)) {
    const { daemonID: _daemonID, ...rest } = value;

    return { daemon: daemon.name, incarnation: daemon.incarnation, ...rest };
  }

  if (Array.isArray(value)) {
    return value.map((item: unknown) => buildRuledValue(item, rules, daemon, `${path}[]`));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => {
        const innerPath = path === '' ? key : `${path}.${key}`;

        return [key, buildRuledValue(inner, rules, daemon, innerPath)];
      }),
    );
  }

  return value;
}
