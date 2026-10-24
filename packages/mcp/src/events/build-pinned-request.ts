import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import type { WebhookRequest } from './types';

interface PinnedRequest {
  // The callback URL with its host swapped for the checked address.
  readonly target: string;
  readonly init: BunFetchRequestInit;
}

// The request goes to the address that passed the check, so a DNS answer that
// changes between the check and the connection cannot redirect it. TLS still
// checks the certificate against the callback's own host name.
export function buildPinnedRequest(
  request: WebhookRequest,
  address: string,
  signal: AbortSignal,
): PinnedRequest {
  const url = new URL(request.url);

  const hostname = url.hostname.replace(/^\[(?<inner>.*)\]$/u, '$<inner>');
  const pinnedHost = isIP(address) === 6 ? `[${address}]` : address;
  const port = url.port === '' ? '' : `:${url.port}`;

  return {
    target: `https://${pinnedHost}${port}${url.pathname}${url.search}`,
    init: {
      method: 'POST',
      headers: { ...request.headers, host: url.host, 'content-type': 'application/json' },
      body: request.body,
      redirect: 'manual',
      signal,
      tls: {
        // SNI carries only a host name, never an address literal.
        ...(isIP(hostname) === 0 ? { serverName: hostname } : {}),
        checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
      },
    },
  };
}
