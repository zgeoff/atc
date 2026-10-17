import { isAbsolute } from 'node:path';
import { expandHome, isHomeRelative, isRecord } from '@atc/core';

export type RemoteDaemonToken =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'command'; readonly argv: readonly string[] };

export interface RemoteDaemon {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly token: RemoteDaemonToken;
  readonly principal: string;
}

interface RemoteDaemonsConfig {
  readonly daemons: ReadonlyMap<string, RemoteDaemon>;
  readonly errors: readonly string[];
}

export function collectRemoteDaemons(raw: unknown, home: string): RemoteDaemonsConfig {
  if (raw === undefined) {
    return { daemons: new Map(), errors: [] };
  }

  if (!isRecord(raw) || Array.isArray(raw)) {
    return { daemons: new Map(), errors: ['daemons must be an object of named daemons'] };
  }

  const daemons = new Map<string, RemoteDaemon>();

  const errors: string[] = [];

  for (const [name, entry] of Object.entries(raw)) {
    const parsed = parseRemoteDaemon(name, entry, home);

    if (typeof parsed === 'string') {
      errors.push(`daemons.${name}: ${parsed}`);
    } else {
      daemons.set(name, parsed);
    }
  }

  return { daemons, errors };
}

// The gateway's daemon name rule, so one name works in both places.
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}$/u;

// `<host>:<port>`, with an IPv6 host in brackets.
const ADDRESS_PATTERN = /^(?:\[(?<v6>[^\]]+)\]|(?<host>[^:[\]]+)):(?<port>\d{1,5})$/u;

// The daemon an entry holds, or the first rule it breaks.
function parseRemoteDaemon(name: string, entry: unknown, home: string): RemoteDaemon | string {
  if (!NAME_PATTERN.test(name)) {
    return 'a daemon name must match ^[a-z][a-z0-9-]{0,30}$';
  }

  if (!isRecord(entry) || Array.isArray(entry)) {
    return 'a daemon must be an object with address, principal, and tokenFile or tokenCommand';
  }

  if (Object.hasOwn(entry, 'token')) {
    return 'a token never goes in the config; set tokenFile or tokenCommand instead';
  }

  const match =
    typeof entry['address'] === 'string' ? ADDRESS_PATTERN.exec(entry['address']) : null;

  const host = match?.groups?.['v6'] ?? match?.groups?.['host'];
  const port = Number(match?.groups?.['port']);

  if (host === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return 'address must be <host>:<port> with a port from 1 to 65535';
  }

  const principal = entry['principal'];

  if (typeof principal !== 'string' || principal === '') {
    return "principal must name a principal in the daemon's own principals map";
  }

  const token = parseRemoteDaemonToken(entry['tokenFile'], entry['tokenCommand'], home);

  if (typeof token === 'string') {
    return token;
  }

  return { name, host, port, token, principal };
}

function parseRemoteDaemonToken(
  file: unknown,
  command: unknown,
  home: string,
): RemoteDaemonToken | string {
  if ((file === undefined) === (command === undefined)) {
    return 'set exactly one of tokenFile and tokenCommand';
  }

  if (file !== undefined) {
    if (typeof file !== 'string' || !(isAbsolute(file) || isHomeRelative(file))) {
      return 'tokenFile must be an absolute path or one under ~';
    }

    return { kind: 'file', path: expandHome(file, home) };
  }

  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === 'string' && part !== '')
  ) {
    return 'tokenCommand must be a non-empty array of non-empty strings';
  }

  return { kind: 'command', argv: command };
}
