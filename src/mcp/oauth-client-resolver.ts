import { readClientMetadataDocument } from './read-client-metadata-document';
import type { FleetCaller, OAuthClientView } from './types';

// A fetched metadata document is reused for 10 minutes.
const METADATA_CACHE_MS = 600_000;

/**
 * Resolves an OAuth client id to the client it identifies: an https URL is a
 * client metadata document, fetched only from a host the operator listed and
 * then reused for 10 minutes, and anything else is a client that registered
 * itself with the daemon. Only a metadata document client is verified: its
 * client id is the URL atc read it from, so its host is proven.
 */
export class OAuthClientResolver {
  private readonly caller: FleetCaller;

  private readonly metadataHosts: readonly string[];

  private readonly now: () => number;

  private readonly cache = new Map<
    string,
    { readonly client: OAuthClientView; readonly at: number }
  >();

  constructor(caller: FleetCaller, metadataHosts: readonly string[], now: () => number) {
    this.caller = caller;
    this.metadataHosts = metadataHosts;
    this.now = now;
  }

  async resolveClient(clientID: string): Promise<OAuthClientView | null> {
    if (!clientID.startsWith('https://')) {
      const found = await this.caller.sendRequest('grant.findClient', { clientID });

      return toClientView(found['client']);
    }

    const cached = this.cache.get(clientID);

    if (cached !== undefined && this.now() - cached.at < METADATA_CACHE_MS) {
      return cached.client;
    }

    const client = await readClientMetadataDocument(clientID, this.metadataHosts);

    if (client !== null) {
      this.cache.set(clientID, { client, at: this.now() });
    }

    return client;
  }
}

function toClientView(raw: unknown): OAuthClientView | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(raw));
  const clientID = record['clientID'];
  const name = record['name'];
  const uris = record['redirectURIs'];

  if (typeof clientID !== 'string' || typeof name !== 'string' || !Array.isArray(uris)) {
    return null;
  }

  return {
    clientID,
    name,
    redirectURIs: uris.filter((uri): uri is string => typeof uri === 'string'),
    verified: false,
  };
}
