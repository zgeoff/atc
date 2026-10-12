import { isRecord } from '../shared/report';

/**
 * Narrows one field of a record to an array of records, for tests reading a
 * list out of a loosely typed protocol reply, such as the sessions of
 * `session.list`. Throws when the field is not an array or holds anything
 * but records, so a malformed reply fails the test instead of passing it.
 */
export function getRecords(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown>[] {
  const inner = value[key];

  if (!Array.isArray(inner) || !inner.every((item) => isRecord(item))) {
    throw new TypeError(`${key} is not an array of records`);
  }

  return inner;
}
