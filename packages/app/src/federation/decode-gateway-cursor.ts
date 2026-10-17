import { isRecord } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import { MAX_EVENTS_CURSOR_BYTES } from './max-events-cursor-bytes';
import type { GatewayRegistry } from './types';

export function decodeGatewayCursor(
  raw: string,
  filter: string,
  registry: GatewayRegistry,
): ReadonlyMap<string, string | null> {
  if (Buffer.byteLength(raw) > MAX_EVENTS_CURSOR_BYTES) {
    throw new DaemonError('bad_args', `cursor exceeds ${MAX_EVENTS_CURSOR_BYTES} bytes`);
  }

  let wire: unknown;

  try {
    wire = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new DaemonError('bad_args', `'${raw}' is not an events cursor`);
  }

  if (!isRecord(wire) || !isRecord(wire['daemons'])) {
    throw new DaemonError('bad_args', `'${raw}' is not an events cursor`);
  }

  if (wire['v'] !== 1) {
    throw new DaemonError('bad_args', 'the events cursor has a version this gateway does not read');
  }

  if (wire['filter'] !== filter) {
    throw new DaemonError('bad_args', 'the events cursor was read under other filters');
  }

  const parts = new Map<string, string | null>();

  for (const [key, position] of Object.entries(wire['daemons'])) {
    const dot = key.indexOf('.');

    if (dot === -1) {
      throw new DaemonError('bad_args', `'${raw}' is not an events cursor`);
    }

    const daemon = registry.daemons.get(key.slice(0, dot));

    if (daemon === undefined) {
      continue;
    }

    if (
      key.slice(dot + 1) !== daemon.incarnation ||
      (typeof position !== 'string' && position !== null)
    ) {
      throw new DaemonError(
        'bad_args',
        `the events cursor holds a stale position for daemon '${daemon.name}'`,
      );
    }

    parts.set(daemon.name, position);
  }

  return parts;
}
