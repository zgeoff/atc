import { isRecord } from '@atc/core';
import { normalizeClientName } from './normalize-client-name';
import { readClientName } from './read-client-name';
import type { HTTPServerContext, Requester, TokenExchangeReason } from './types';

interface RefusedExchange {
  // The refused request's body, read only for its client id.
  readonly contentType: string | null;
  readonly body: string;
  readonly response: Response;
  readonly path: string;
  readonly requester: Requester;
}

// The event holds better-auth's error code from a fixed list, and the
// client's id and name only for a client atc holds. It never holds the
// code, the verifier, or a token the request carried.
export async function recordRefusedExchange(
  ctx: Pick<HTTPServerContext, 'store' | 'security'>,
  exchange: RefusedExchange,
): Promise<void> {
  const code = await readErrorCode(exchange.response);

  const reason = isTokenExchangeError(code) ? code : 'other';
  const clientID = findClientID(exchange);
  const storedName = clientID === null ? null : await readClientName(ctx.store.db, clientID);

  ctx.security.record({
    kind: 'token_exchange',
    outcome: 'rejected',
    reason,
    path: exchange.path,
    requester: exchange.requester,
    ...(clientID === null || storedName === null
      ? {}
      : { client: { id: clientID, name: normalizeClientName(storedName) } }),
  });
}

async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.clone().json();

    return isRecord(body) && typeof body['error'] === 'string' ? body['error'] : null;
  } catch {
    return null;
  }
}

// A fixed list keeps the reason a value a log rule can match, whatever text
// a future better-auth puts in its error field.
const TOKEN_EXCHANGE_ERRORS: ReadonlySet<string> = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'invalid_target',
]);

function isTokenExchangeError(code: string | null): code is TokenExchangeReason {
  return code !== null && TOKEN_EXCHANGE_ERRORS.has(code);
}

function findClientID(exchange: RefusedExchange): string | null {
  if (exchange.contentType?.startsWith('application/x-www-form-urlencoded') !== true) {
    return null;
  }

  return new URLSearchParams(exchange.body).get('client_id');
}
