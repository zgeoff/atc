import { lookup } from 'node:dns/promises';
import { isPublicAddress } from './is-public-address';
import { parseClientMetadataDocument } from './parse-client-metadata-document';
import type { OAuthClientView } from './types';

// A metadata document is a few hundred bytes; anything far larger is not one.
const MAX_DOCUMENT_BYTES = 16_384;

/**
 * Reads the client metadata document a URL client id points at. Only an https
 * URL on a host the operator listed is fetched, and only when every address
 * the host resolves to is public, so a crafted client id cannot make atc
 * reach into the local network. Redirects are refused. Returns null when any
 * check fails or the document is not valid.
 */
export async function readClientMetadataDocument(
  clientID: string,
  allowedHosts: readonly string[],
): Promise<OAuthClientView | null> {
  let url: URL;

  try {
    url = new URL(clientID);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || url.hash !== '' || !allowedHosts.includes(url.hostname)) {
    return null;
  }

  const resolved = await lookup(url.hostname, { all: true }).catch(() => []);

  if (resolved.length === 0 || !resolved.every((entry) => isPublicAddress(entry.address))) {
    return null;
  }

  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: { accept: 'application/json' },
  }).catch(() => null);

  if (response === null || !response.ok) {
    return null;
  }

  const text = await response.text();

  if (text.length > MAX_DOCUMENT_BYTES) {
    return null;
  }

  try {
    return parseClientMetadataDocument(clientID, JSON.parse(text));
  } catch {
    return null;
  }
}
