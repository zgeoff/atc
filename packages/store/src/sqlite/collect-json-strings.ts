/**
 * The strings in a column holding a JSON array, which is how atc's
 * databases store a list. Anything else, malformed JSON included, holds
 * none.
 */
export function collectJSONStrings(raw: string): readonly string[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : [];
}
