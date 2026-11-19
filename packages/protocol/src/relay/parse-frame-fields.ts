export type FrameFields = Readonly<Record<string, unknown>>;

// The fields of a line that holds a JSON object, or null for any other line, such as bytes a host
// printed before the mux started.
export function parseFrameFields(line: string): FrameFields | null {
  let json: unknown;

  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }

  return isFields(json) ? json : null;
}

function isFields(value: unknown): value is FrameFields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
