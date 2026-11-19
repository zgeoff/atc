// The problem of a file that sets `sources` beside an old source key.
export function formatMixedSourceKeys(firstKey: string): string {
  return `${firstKey} cannot be set together with sources; move it into sources and remove it`;
}
