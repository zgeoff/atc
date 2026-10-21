import { DaemonError } from '@atc/protocol/wire';
import { z } from 'zod';
import { MAX_EVENTS_CURSOR_BYTES } from './max-events-cursor-bytes';
import type { GatewayRegistry } from './types';

// The fields are read one by one, so each refusal names the field it failed on.
const CURSOR_SCHEMA = z.object({
  version: z.unknown().optional(),
  filter: z.unknown().optional(),
  daemons: z.record(z.string(), z.unknown()),
});

const POSITION_SCHEMA = z.string().nullable();

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

  const cursor = CURSOR_SCHEMA.safeParse(wire);

  if (!cursor.success) {
    throw new DaemonError('bad_args', `'${raw}' is not an events cursor`);
  }

  if (cursor.data.version !== 1) {
    throw new DaemonError('bad_args', 'the events cursor has a version this gateway does not read');
  }

  if (cursor.data.filter !== filter) {
    throw new DaemonError('bad_args', 'the events cursor was read under other filters');
  }

  const parts = new Map<string, string | null>();

  for (const [key, rawPosition] of Object.entries(cursor.data.daemons)) {
    const dot = key.indexOf('.');

    if (dot === -1) {
      throw new DaemonError('bad_args', `'${raw}' is not an events cursor`);
    }

    const daemon = registry.daemons.get(key.slice(0, dot));

    if (daemon === undefined) {
      continue;
    }

    const position = POSITION_SCHEMA.safeParse(rawPosition);

    if (key.slice(dot + 1) !== daemon.incarnation || !position.success) {
      throw new DaemonError(
        'bad_args',
        `the events cursor holds a stale position for daemon '${daemon.name}'`,
      );
    }

    parts.set(daemon.name, position.data);
  }

  return parts;
}
