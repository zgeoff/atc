import { DaemonError } from '../protocol/daemon-error';
import { isRecord } from '../shared/report';
import type { GatewayRegistry } from './types';

// The largest gateway cursor the gateway reads.
const MAX_CURSOR_BYTES = 4096;

/**
 * Each registry daemon's position in a gateway events cursor, by daemon
 * name: its own cursor, or null for a daemon read from the start. A daemon
 * the cursor leaves out is absent. The gateway refuses with `bad_args` a
 * cursor over 4 KiB, one it cannot decode, one with a version other than
 * 1, one read under another filter, and one whose part for a daemon holds
 * another incarnation than the registry pins. A part for a name the
 * registry no longer lists is dropped.
 */
export function decodeGatewayCursor(
  raw: string,
  filter: string,
  registry: GatewayRegistry,
): ReadonlyMap<string, string | null> {
  if (Buffer.byteLength(raw) > MAX_CURSOR_BYTES) {
    throw new DaemonError('bad_args', `cursor exceeds ${MAX_CURSOR_BYTES} bytes`);
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
      (position !== null && typeof position !== 'string')
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
