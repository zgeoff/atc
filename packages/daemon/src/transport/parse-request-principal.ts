import { PRINCIPAL_HEADERS } from '@atc/protocol/wire';
import { AtcError } from '@atcx/contract/light';
import type { RequestPrincipal } from './request-deps';

type PeerHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

// Refuse a malformed principal instead of returning null: null would leave the request with the
// whole reach of the connection.
export function parseRequestPrincipal(headers: PeerHeaders): RequestPrincipal | null {
  const as = headers[PRINCIPAL_HEADERS.as];
  const name = headers[PRINCIPAL_HEADERS.asName];

  if (as !== undefined && (typeof as !== 'string' || as === '')) {
    throw new AtcError('bad_args', 'as must be a non-empty string');
  }

  if (name !== undefined && (typeof name !== 'string' || name === '')) {
    throw new AtcError('bad_args', 'asName must be a non-empty string');
  }

  if (as === undefined) {
    if (name !== undefined) {
      throw new AtcError('bad_args', 'asName needs as');
    }

    return null;
  }

  return { principal: as, name };
}
