import { createHash, timingSafeEqual } from 'node:crypto';
import type { GrantScope } from '@atcx/contract';
import { buildServiceClientID } from './build-service-client-id';
import type { ServiceTokenFile } from './parse-service-token-file';
import type { VerifiedAccess } from './types';

export interface ServiceTokenVerifier {
  // The access a service token grants, or null for any other value.
  readonly verify: (token: string) => VerifiedAccess | null;

  // The scopes of a service client, or null for an ID the file does not list.
  readonly findScopes: (clientID: string) => readonly GrantScope[] | null;
}

interface StoredToken {
  readonly digest: Buffer;
  readonly access: VerifiedAccess;
}

// Only the digests of the tokens stay in memory.
export function buildServiceTokenVerifier(file: ServiceTokenFile): ServiceTokenVerifier {
  const stored: StoredToken[] = file.clients.flatMap((client) => {
    const clientID = buildServiceClientID(client.name);
    const access: VerifiedAccess = { clientID, clientName: clientID, scopes: client.scopes };

    return client.tokens.map((token) => ({ digest: toDigest(token), access }));
  });

  return {
    verify: (token) => {
      const presented = toDigest(token);
      let match: VerifiedAccess | null = null;

      // Every stored token is compared, so the time taken does not say which
      // one matched.
      for (const entry of stored) {
        if (timingSafeEqual(presented, entry.digest)) {
          match = entry.access;
        }
      }

      return match;
    },
    findScopes: (clientID) =>
      stored.find((entry) => entry.access.clientID === clientID)?.access.scopes ?? null,
  };
}

function toDigest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
