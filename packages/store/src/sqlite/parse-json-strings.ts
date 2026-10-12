/**
 * The strings in a column holding a JSON array, which is how atc's
 * databases store a list; an item that is not a string drops out. A value
 * that is not JSON, or not an array, returns null, so a caller can tell a
 * malformed column from an empty list.
 */
export function parseJSONStrings(raw: string): string[] | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : null;
}
