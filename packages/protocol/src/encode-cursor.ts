export type Cursor =
  | { readonly kind: 'events'; readonly id: number }
  | { readonly kind: 'transcript'; readonly path: string; readonly offset: number };

export function encodeCursor(cursor: Cursor): string {
  const wire =
    cursor.kind === 'events'
      ? { k: 'ev', i: cursor.id }
      : { k: 'tr', p: cursor.path, o: cursor.offset };

  return Buffer.from(JSON.stringify(wire), 'utf8').toString('base64url');
}
