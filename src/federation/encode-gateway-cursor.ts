/**
 * A gateway events cursor: base64url JSON of `{ v: 1, filter, daemons }`,
 * where `daemons` maps `<name>.<incarnation>` to that daemon's own cursor,
 * always a concrete position. The decoder refuses a cursor whose version,
 * filter, or incarnations do not match.
 */
export function encodeGatewayCursor(filter: string, daemons: ReadonlyMap<string, string>): string {
  const wire = { v: 1, filter, daemons: Object.fromEntries(daemons) };

  return Buffer.from(JSON.stringify(wire), 'utf8').toString('base64url');
}
