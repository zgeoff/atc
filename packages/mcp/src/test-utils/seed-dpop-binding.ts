import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { DPoPKey } from './sign-dpop-proof';

// Binds every access token in the store to the key, as better-auth writes a
// token it issues against a DPoP proof: the key's RFC 7638 thumbprint in the
// `confirmation` column.
export function seedDPoPBinding(sqlite: Database, key: DPoPKey): void {
  const jkt = createHash('sha256')
    .update(
      JSON.stringify({
        crv: key.publicJWK.crv,
        kty: key.publicJWK.kty,
        x: key.publicJWK.x,
        y: key.publicJWK.y,
      }),
    )
    .digest('base64url');

  sqlite.run('update "oauthAccessToken" set "confirmation" = ?', [JSON.stringify({ jkt })]);
}
