/**
 * The first `length` letters and digits of `value`, lowercased: the part of
 * an imp, session, or socket name that comes from an atc id, which impd and
 * a unix socket path each take at a bounded length.
 */
export function buildShortName(value: string, length: number): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, '')
    .slice(0, length);
}
