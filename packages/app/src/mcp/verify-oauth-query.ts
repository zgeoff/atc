import { constantTimeEqual, makeSignature } from 'better-auth/crypto';

/**
 * Whether a signed authorization query is one better-auth signed with this
 * secret and has not expired: exactly one `sig`, matching the HMAC of every
 * other parameter sorted by name and then value, and an `exp` still ahead.
 */
export async function verifyOAuthQuery(oauthQuery: string, secret: string): Promise<boolean> {
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
      const a = `${keyA}\u0000${valueA}`;
      const b = `${keyB}\u0000${valueB}`;

      if (a === b) {
        return 0;
      }

      return a < b ? -1 : 1;
    }),
  );

  const expected = await makeSignature(canonical.toString(), secret);

  return (
    constantTimeEqual(signature, expected) && Number.isFinite(expiresAt) && expiresAt >= Date.now()
  );
}
