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
