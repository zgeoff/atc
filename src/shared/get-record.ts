import { isRecord } from './report';

/**
 * Narrows one field of a record to a record, for tests pulling a nested
 * payload (a wire event's session descriptor, a response's session) out of
 * loosely typed JSON. Throws rather than letting a malformed fixture pass a
 * test vacuously.
 */
export function getRecord(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  const inner = value[key];

  if (!isRecord(inner)) {
    throw new TypeError(`${key} is not an object`);
  }

  return inner;
}
