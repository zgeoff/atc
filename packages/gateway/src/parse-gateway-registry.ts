import { z } from 'zod';
import { MAX_EVENTS_CURSOR_BYTES } from './max-events-cursor-bytes';
import { MAX_REGISTRY_DAEMONS } from './max-registry-daemons';
import type { GatewayRegistry, RegistryDaemon } from './types';

type ParsedGatewayRegistry =
  | { readonly ok: true; readonly registry: GatewayRegistry }
  | { readonly ok: false; readonly errors: readonly string[] };

const REGISTRY_SCHEMA = z.object({
  daemons: z.record(z.string(), z.unknown()),
  defaultDaemon: z.unknown().optional(),
});

export function parseGatewayRegistry(
  raw: unknown,
  env: Readonly<Record<string, string | undefined>>,
): ParsedGatewayRegistry {
  const parsed = REGISTRY_SCHEMA.safeParse(raw);

  if (!parsed.success) {
    return { ok: false, errors: ['the registry must be an object whose daemons is an object'] };
  }

  const daemons = new Map<string, RegistryDaemon>();

  const errors: string[] = [];

  for (const [name, entry] of Object.entries(parsed.data.daemons)) {
    const daemon = parseRegistryDaemon(name, entry, env);

    if (typeof daemon === 'string') {
      errors.push(daemon);
    } else {
      daemons.set(name, daemon);
    }
  }

  const count = Object.keys(parsed.data.daemons).length;

  if (count === 0) {
    errors.push('the registry lists no daemon');
  }

  if (count > MAX_REGISTRY_DAEMONS) {
    errors.push(
      `the registry lists ${count} daemons, over the limit of ${MAX_REGISTRY_DAEMONS}, the most whose events cursor fits ${MAX_EVENTS_CURSOR_BYTES} bytes`,
    );
  }

  const defaultDaemon = z.string().safeParse(parsed.data.defaultDaemon);

  if (!defaultDaemon.success) {
    errors.push('defaultDaemon is required and must name a daemon in the registry');
  } else if (!Object.hasOwn(parsed.data.daemons, defaultDaemon.data)) {
    errors.push(`defaultDaemon '${defaultDaemon.data}' is not a daemon in the registry`);
  }

  if (errors.length > 0 || !defaultDaemon.success) {
    return { ok: false, errors };
  }

  return { ok: true, registry: { daemons, defaultDaemon: defaultDaemon.data } };
}

// A daemon name: never a `.`, which separates the parts of a gateway id.
const NAME_SCHEMA = z.string().regex(/^[a-z][a-z0-9-]{0,30}$/u);

const ENTRY_SCHEMA = z.object({
  address: z.unknown().optional(),
  daemonID: z.unknown().optional(),
});

// `<host>:<port>`, with an IPv6 host in brackets.
const ADDRESS_PATTERN = /^(?:\[(?<v6>[^\]]+)\]|(?<host>[^:[\]]+)):(?<port>\d{1,5})$/u;

const ADDRESS_SCHEMA = z
  .string()
  .transform((raw) => {
    const groups = ADDRESS_PATTERN.exec(raw)?.groups;

    return { host: groups?.['v6'] ?? groups?.['host'], port: groups?.['port'] };
  })
  .pipe(z.object({ host: z.string(), port: z.coerce.number<string>().int().min(1).max(65_535) }));

// A daemon ID as a daemon mints it: a lowercase UUID.
const DAEMON_ID_SCHEMA = z
  .string()
  .regex(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u);

// One daemon entry, or the problem that refuses it.
function parseRegistryDaemon(
  name: string,
  raw: unknown,
  env: Readonly<Record<string, string | undefined>>,
): RegistryDaemon | string {
  if (!NAME_SCHEMA.safeParse(name).success) {
    return `daemon name '${name}' must match ^[a-z][a-z0-9-]{0,30}$`;
  }

  const entry = ENTRY_SCHEMA.safeParse(raw);

  if (!entry.success) {
    return `daemon '${name}' must be an object with address and daemonID`;
  }

  const address = ADDRESS_SCHEMA.safeParse(entry.data.address);

  if (!address.success) {
    return `daemon '${name}' needs an address of <host>:<port> with a port from 1 to 65535`;
  }

  const daemonID = DAEMON_ID_SCHEMA.safeParse(entry.data.daemonID);

  if (!daemonID.success) {
    return `daemon '${name}' needs the daemonID that atc daemon id prints on its host`;
  }

  const tokenVar = `ATC_GATEWAY_TOKEN_${name.toUpperCase().replaceAll('-', '_')}`;
  const token = env[tokenVar];

  if (token === undefined || token === '') {
    return `daemon '${name}' has no token: set ${tokenVar}`;
  }

  return {
    name,
    address: address.data,
    daemonID: daemonID.data,
    incarnation: daemonID.data.slice(0, 8),
    token,
  };
}
