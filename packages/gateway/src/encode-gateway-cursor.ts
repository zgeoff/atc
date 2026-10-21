export function encodeGatewayCursor(
  filter: string,
  daemons: ReadonlyMap<string, string | null>,
): string {
  const wire = { version: 1, filter, daemons: Object.fromEntries(daemons) };

  return Buffer.from(JSON.stringify(wire), 'utf8').toString('base64url');
}
