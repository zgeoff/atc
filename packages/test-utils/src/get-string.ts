/**
 * Narrows one field of a record to a string, for tests pulling an id or a
 * command out of a loosely typed protocol reply. Throws rather than letting a
 * malformed reply pass a test vacuously.
 */
export function getString(value: Readonly<Record<string, unknown>>, key: string): string {
  const inner = value[key];

  if (typeof inner !== 'string') {
    throw new TypeError(`${key} is not a string`);
  }

  return inner;
}
