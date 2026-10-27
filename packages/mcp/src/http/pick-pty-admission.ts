import { parsePTYProtocols } from './parse-pty-protocols';

// The headers of a request for a session's live terminal, and whether the
// server can serve one yet.
interface PTYAdmissionRequest {
  readonly host: string | null;
  readonly upgrade: string | null;
  readonly origin: string | null;
  readonly protocols: string | null;
  readonly isServing: boolean;
}

interface PTYAdmissionPolicy {
  readonly hosts: ReadonlySet<string>;
  readonly allowedOrigins: ReadonlySet<string>;
}

// A refusal that the security log records.
export type PTYRefusalOutcome =
  | { readonly kind: 'authorize_invalid'; readonly reason: 'bad_host' | 'bad_origin' }
  | { readonly kind: 'bearer'; readonly reason: 'malformed' | 'invalid_token' };

type PTYAdmission =
  | {
      readonly kind: 'refuse';
      readonly status: 400 | 401 | 403 | 503;
      readonly outcome: PTYRefusalOutcome | null;
    }
  | { readonly kind: 'upgrade_required' }
  | { readonly kind: 'verify'; readonly token: string };

// Every check before the token is verified, in the order the server answers
// them, so a request from a host the server does not answer to learns
// nothing else.
export function pickPTYAdmission(
  request: PTYAdmissionRequest,
  policy: PTYAdmissionPolicy,
): PTYAdmission {
  if (request.host === null || !policy.hosts.has(request.host)) {
    return {
      kind: 'refuse',
      status: 403,
      outcome: { kind: 'authorize_invalid', reason: 'bad_host' },
    };
  }

  if (!request.isServing) {
    return { kind: 'refuse', status: 503, outcome: null };
  }

  if (request.upgrade?.toLowerCase() !== 'websocket') {
    return { kind: 'upgrade_required' };
  }

  // A request with no Origin header comes from no browser page, so only the
  // bearer token gates it.
  if (request.origin !== null && !policy.allowedOrigins.has(request.origin)) {
    return {
      kind: 'refuse',
      status: 403,
      outcome: { kind: 'authorize_invalid', reason: 'bad_origin' },
    };
  }

  const protocols = parsePTYProtocols(request.protocols);

  if (!protocols.ok && protocols.reason === 'no_protocol') {
    return { kind: 'refuse', status: 400, outcome: null };
  }

  if (!protocols.ok) {
    return { kind: 'refuse', status: 401, outcome: { kind: 'bearer', reason: 'malformed' } };
  }

  return { kind: 'verify', token: protocols.token };
}
