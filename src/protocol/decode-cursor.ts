import { z } from 'zod';
import type { Cursor } from './encode-cursor';

const WIRE_CURSOR = z.discriminatedUnion('k', [
  z.object({ k: z.literal('ev'), i: z.number().int().nonnegative() }),
  z.object({ k: z.literal('tr'), p: z.string(), o: z.number().int().nonnegative() }),
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

  if (parsed.data.k === 'ev') {
    return { kind: 'events', id: parsed.data.i };
  }

  return { kind: 'transcript', path: parsed.data.p, offset: parsed.data.o };
}
