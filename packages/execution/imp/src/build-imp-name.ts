/**
 * The imp a host key runs on: the target's imp name prefix and the first
 * 20 letters and digits of the key, which is the atc session id of the
 * session that owns the host.
 */
export function buildImpName(impPrefix: string, hostKey: string): string {
  return `${impPrefix}${hostKey
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '')
    .slice(0, 20)}`;
}
