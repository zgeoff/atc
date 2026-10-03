/**
 * The kind of a decoded JSON value, as an error detail: "null", "an array",
 * "an object", "a string", "a number", or "a boolean". It never includes
 * the value itself, so a config diagnostic built from it holds nothing the
 * file holds.
 */
export function formatJSONKind(raw: unknown): string {
  if (raw === null) {
    return 'null';
  }

  if (Array.isArray(raw)) {
    return 'an array';
  }

  if (typeof raw === 'object') {
    return 'an object';
  }

  return `a ${typeof raw}`;
}
