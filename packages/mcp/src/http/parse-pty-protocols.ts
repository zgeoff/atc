// The subprotocol a live-terminal socket speaks, which the server selects in
// its upgrade answer.
export const PTY_PROTOCOL = 'atc.pty.v1';

// A browser cannot set an Authorization header on a WebSocket, so the bearer
// token rides as a second subprotocol, base64url-encoded because a
// subprotocol takes only the characters of an HTTP token.
const BEARER_PREFIX = 'atc.bearer.';

type ParsedPTYProtocols =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: 'no_protocol' | 'no_token' };

export function parsePTYProtocols(header: string | null): ParsedPTYProtocols {
  const offered = (header ?? '')
    .split(',')
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol !== '');

  if (!offered.includes(PTY_PROTOCOL)) {
    return { ok: false, reason: 'no_protocol' };
  }

  const bearers = offered.filter((protocol) => protocol.startsWith(BEARER_PREFIX));
  const encoded = bearers.length === 1 ? (bearers[0]?.slice(BEARER_PREFIX.length) ?? '') : '';
  const token = Buffer.from(encoded, 'base64url').toString('utf8');

  return token === '' ? { ok: false, reason: 'no_token' } : { ok: true, token };
}
