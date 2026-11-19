import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { DPoPKey } from './sign-dpop-proof';

// better-auth stores a DPoP-bound token's key as its RFC 7638 thumbprint in the `confirmation`
// column; writing the same shape makes every stored token look issued against a proof.
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
