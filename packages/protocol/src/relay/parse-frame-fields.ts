export type FrameFields = Readonly<Record<string, unknown>>;

// A host may print non-JSON bytes before the mux starts.
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
