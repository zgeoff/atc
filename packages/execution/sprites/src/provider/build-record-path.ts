const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u;

// The path of a read-only record in the guest folder, or null for a path that is not relative or
// whose segments leave the folder.
export function buildRecordPath(guestDir: string, path: string): string | null {
  const segments = path.split('/');

  return segments.every((segment) => SEGMENT.test(segment))
    ? `${guestDir}/records/${segments.join('/')}`
    : null;
}
