import { isRecord } from '../shared/report';
import type { GatewayRegistry, RegistryDaemon } from './types';

// A daemon name: never a `.`, which separates the parts of a gateway id.
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;

// A daemon ID as a daemon mints it: a lowercase UUID.
const DAEMON_ID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

// `<host>:<port>`, with an IPv6 host in brackets.
const ADDRESS_PATTERN = /^(?:\[(?<v6>[^\]]+)\]|(?<host>[^:[\]]+)):(?<port>\d{1,5})$/;

type ParsedGatewayRegistry =
  | { readonly ok: true; readonly registry: GatewayRegistry }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Parses a registry file's JSON and the environment the tokens come from.
 * Every daemon needs a name matching `^[a-z][a-z0-9-]{0,30}$`, an address,
 * a pinned `daemonID`, and a non-empty token in `ATC_GATEWAY_TOKEN_<NAME>`
 * (the name upper-cased, `-` as `_`). `defaultDaemon` is required and must
 * be one of the daemons. Any problem refuses the whole registry, so the
 * gateway never starts with part of its fleet.
 */
export function parseGatewayRegistry(
  raw: unknown,
  env: Readonly<Record<string, string | undefined>>,
): ParsedGatewayRegistry {
  if (!isRecord(raw) || !isRecord(raw['daemons']) || Array.isArray(raw['daemons'])) {
    return { ok: false, errors: ['the registry must be an object whose daemons is an object'] };
  }

  const daemons = new Map<string, RegistryDaemon>();

  const errors: string[] = [];

  for (const [name, entry] of Object.entries(raw['daemons'])) {
    const parsed = parseRegistryDaemon(name, entry, env);

    if (typeof parsed === 'string') {
      errors.push(parsed);
    } else {
      daemons.set(name, parsed);
    }
  }

  if (Object.keys(raw['daemons']).length === 0) {
    errors.push('the registry lists no daemon');
  }

  const defaultDaemon = raw['defaultDaemon'];

  if (typeof defaultDaemon !== 'string') {
    errors.push('defaultDaemon is required and must name a daemon in the registry');
  } else if (!Object.hasOwn(raw['daemons'], defaultDaemon)) {
    errors.push(`defaultDaemon '${defaultDaemon}' is not a daemon in the registry`);
  }

  if (errors.length > 0 || typeof defaultDaemon !== 'string') {
    return { ok: false, errors };
  }

  return { ok: true, registry: { daemons, defaultDaemon } };
}

// One daemon entry, or the problem that refuses it.
function parseRegistryDaemon(
  name: string,
  entry: unknown,
  env: Readonly<Record<string, string | undefined>>,
): RegistryDaemon | string {
  if (!NAME_PATTERN.test(name)) {
    return `daemon name '${name}' must match ^[a-z][a-z0-9-]{0,30}$`;
  }

  if (!isRecord(entry)) {
    return `daemon '${name}' must be an object with address and daemonID`;
  }

  const address = typeof entry['address'] === 'string' ? parseAddress(entry['address']) : null;

  if (address === null) {
    return `daemon '${name}' needs an address of <host>:<port> with a port from 1 to 65535`;
  }

  const daemonID = entry['daemonID'];

  if (typeof daemonID !== 'string' || !DAEMON_ID_PATTERN.test(daemonID)) {
    return `daemon '${name}' needs the daemonID that atc daemon id prints on its host`;
  }

  const tokenVar = `ATC_GATEWAY_TOKEN_${name.toUpperCase().replaceAll('-', '_')}`;
  const token = env[tokenVar];

  if (token === undefined || token === '') {
    return `daemon '${name}' has no token: set ${tokenVar}`;
  }

  return { name, address, daemonID, incarnation: daemonID.slice(0, 8), token };
}

function parseAddress(raw: string): { readonly host: string; readonly port: number } | null {
  const match = ADDRESS_PATTERN.exec(raw);
  const host = match?.groups?.['v6'] ?? match?.groups?.['host'];
  const port = Number(match?.groups?.['port']);

  if (host === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }

  return { host, port };
}
