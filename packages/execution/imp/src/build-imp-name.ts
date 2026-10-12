import { buildShortName } from './build-short-name';

/**
 * The imp a host key runs on: the target's imp name prefix and the first
 * 20 letters and digits of the key, which is the atc session id of the
 * session that owns the host.
 */
export function buildImpName(impPrefix: string, hostKey: string): string {
  return `${impPrefix}${buildShortName(hostKey, 20)}`;
}
