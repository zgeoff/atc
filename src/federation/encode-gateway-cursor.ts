/**
 * A gateway events cursor: base64url JSON of `{ v: 1, filter, daemons }`,
 * where `daemons` maps `<name>.<incarnation>` to that daemon's own cursor,
 * or to null for a daemon read from the start of its trail. The decoder
 * refuses a cursor whose version, filter, or incarnations do not match.
 */
export function encodeGatewayCursor(
  filter: string,
  daemons: ReadonlyMap<string, string | null>,
): string {
  const wire = { v: 1, filter, daemons: Object.fromEntries(daemons) };

  return Buffer.from(JSON.stringify(wire), 'utf8').toString('base64url');
}
