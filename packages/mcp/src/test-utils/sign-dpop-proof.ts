import invariant from 'tiny-invariant';

export interface PublicJWK {
  readonly kty: string;
  readonly crv: string;
  readonly x: string;
  readonly y: string;
}

export interface DPoPKey {
  readonly privateKey: CryptoKey;
  readonly publicJWK: PublicJWK;
}

interface DPoPProofRequest {
  readonly key: DPoPKey;
  readonly method: string;
  readonly url: string;
  readonly now: number;
}

const encoder = new TextEncoder();

export async function generateDPoPKey(): Promise<DPoPKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ]);

  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);

  invariant(
    exported.kty !== undefined &&
      exported.crv !== undefined &&
      exported.x !== undefined &&
      exported.y !== undefined,
    'the exported P-256 key lacks a coordinate',
  );

  return {
    privateKey: pair.privateKey,
    publicJWK: { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y },
  };
}

export async function signDPoPProof(request: DPoPProofRequest): Promise<string> {
  const header = encodeSegment({ typ: 'dpop+jwt', alg: 'ES256', jwk: request.key.publicJWK });

  const claims = encodeSegment({
    htm: request.method,
    htu: request.url,
    iat: Math.floor(request.now / 1000),
    jti: crypto.randomUUID(),
  });

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    request.key.privateKey,
    encoder.encode(`${header}.${claims}`),
  );

  return `${header}.${claims}.${Buffer.from(signature).toString('base64url')}`;
}

function encodeSegment(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
