import { DaemonError, PRINCIPAL_HEADERS } from '@atc/protocol/wire';
import type { RequestPrincipal } from './request-deps';

type PeerHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

// The principal a peer request acts as, from its headers; null when it gives
// none. A malformed principal refuses the request rather than leave it with
// the connection's whole reach, and so does a name without a principal.
export function parseRequestPrincipal(headers: PeerHeaders): RequestPrincipal | null {
  const as = headers[PRINCIPAL_HEADERS.as];
  const name = headers[PRINCIPAL_HEADERS.asName];

  if (as !== undefined && (typeof as !== 'string' || as === '')) {
    throw new DaemonError('bad_args', 'as must be a non-empty string');
  }

  if (name !== undefined && (typeof name !== 'string' || name === '')) {
    throw new DaemonError('bad_args', 'asName must be a non-empty string');
  }

  if (as === undefined) {
    if (name !== undefined) {
      throw new DaemonError('bad_args', 'asName needs as');
    }

    return null;
  }

  return { principal: as, name };
}
