import { expect, test } from 'bun:test';
import { generateDPoPKey, signDPoPProof } from './sign-dpop-proof';

test('it signs a dpop+jwt proof that names the request and verifies under the key it carries', async () => {
  const key = await generateDPoPKey();

  const proof = await signDPoPProof({
    key,
    method: 'POST',
    url: 'https://atc.example/oauth2/token',
    now: Date.parse('2026-11-19T10:00:00.000Z'),
  });

  const [header = '', claims = '', signature = ''] = proof.split('.');
  const parsedHeader: unknown = JSON.parse(Buffer.from(header, 'base64url').toString());
  const parsedClaims: unknown = JSON.parse(Buffer.from(claims, 'base64url').toString());

  const publicKey = await crypto.subtle.importKey(
    'jwk',
    key.publicJWK,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );

  const verified = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    Buffer.from(signature, 'base64url'),
    new TextEncoder().encode(`${header}.${claims}`),
  );

  expect({ header: parsedHeader, claims: parsedClaims, verified }).toStrictEqual({
    header: { typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJWK },
    claims: {
      htm: 'POST',
      htu: 'https://atc.example/oauth2/token',
      iat: 1_795_082_400,
      jti: expect.toBeString(),
    },
    verified: true,
  });
});
