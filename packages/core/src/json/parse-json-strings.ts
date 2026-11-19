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
