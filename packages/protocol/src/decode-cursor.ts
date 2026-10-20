import { z } from 'zod';
import type { Cursor } from './encode-cursor';

const WIRE_CURSOR = z.union([
  z.tuple([z.literal('events'), z.number().int().nonnegative()]),
  z.tuple([z.literal('transcript'), z.string(), z.number().int().nonnegative()]),
]);

export function decodeCursor(raw: string): Cursor | null {
  let json: unknown;

  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const parsed = WIRE_CURSOR.safeParse(json);

  if (!parsed.success) {
    return null;
  }

  const wire = parsed.data;

  return wire[0] === 'events'
    ? { kind: 'events', id: wire[1] }
    : { kind: 'transcript', path: wire[1], offset: wire[2] };
}
