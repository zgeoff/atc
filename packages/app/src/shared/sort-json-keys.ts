/**
 * Returns a JSON value with every object's keys in sorted order, at every
 * depth, so two values that differ only in key order serialize the same.
 */
export function sortJSONKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJSONKeys(item));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJSONKeys(item)]),
    );
  }

  return value;
}
