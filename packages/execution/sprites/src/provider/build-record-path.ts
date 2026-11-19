const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u;

export function buildRecordPath(guestDir: string, path: string): string | null {
  const segments = path.split('/');

  return segments.every((segment) => SEGMENT.test(segment))
    ? `${guestDir}/records/${segments.join('/')}`
    : null;
}
