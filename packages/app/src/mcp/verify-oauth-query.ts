import { constantTimeEqual, makeSignature } from 'better-auth/crypto';

export async function verifyOAuthQuery(
  oauthQuery: string,
  secret: string,
  now: number,
): Promise<boolean> {
  const params = new URLSearchParams(oauthQuery);

  const signatures = params.getAll('sig');
  const [signature] = signatures;
  const expiresAt = Number(params.get('exp')) * 1000;

  if (signatures.length !== 1 || signature === undefined || signature === '') {
    return false;
  }

  params.delete('sig');

  // Ordered by name, then by value, comparing code units as better-auth does
  // when it signs; the NUL separator sorts a name before any longer name it
  // prefixes.
  const canonical = new URLSearchParams(
    [...params].toSorted(([keyA, valueA], [keyB, valueB]) => {
      const pairA = `${keyA}\u0000${valueA}`;
      const pairB = `${keyB}\u0000${valueB}`;

      if (pairA === pairB) {
        return 0;
      }

      return pairA < pairB ? -1 : 1;
    }),
  );

  const expected = await makeSignature(canonical.toString(), secret);

  return constantTimeEqual(signature, expected) && Number.isFinite(expiresAt) && expiresAt >= now;
}
