export type Cursor =
  | { readonly kind: 'events'; readonly id: number }
  | { readonly kind: 'transcript'; readonly path: string; readonly offset: number };

// A cursor goes on the wire as a tuple, the shortest JSON that holds it, so
// the gateway's cursor fits the positions of as many daemons as it can.
export function encodeCursor(cursor: Cursor): string {
  const wire =
    cursor.kind === 'events' ? [cursor.kind, cursor.id] : [cursor.kind, cursor.path, cursor.offset];

  return Buffer.from(JSON.stringify(wire), 'utf8').toString('base64url');
}
