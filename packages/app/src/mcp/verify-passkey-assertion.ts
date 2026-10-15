import { parseJSONStrings } from '@atc/core/parse-json-strings';
import type {
  AuthenticationResponseJSON,
  VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { loadWebAuthn } from './load-web-authn';
import type { MCPAuthSchema } from './mcp-auth-schema';

interface AssertionCheck {
  // The credential JSON the sign-in page posted.
  readonly credential: string;

  // The challenge the page was given, which the caller has already taken.
  readonly challenge: string;
  readonly origin: string;
  readonly rpID: string;

  // Epoch milliseconds, stamped as the passkey's last use.
  readonly now: number;
}

/**
 * The id of the enrolled passkey a posted WebAuthn assertion signs the
 * owner in with, or null when it does not: it parses, its
 * credential is an enrolled passkey, and it verifies against that passkey's
 * public key with the expected challenge, origin, and RP ID, with the user
 * verified and a signature counter past the stored one when the
 * authenticator keeps one. A passing assertion stores its counter and the
 * time of use, and passes only if the passkey still holds the counter it
 * was checked against when that store runs. Any failure is null, never a
 * throw.
 */
export async function verifyPasskeyAssertion(
  db: Kysely<MCPAuthSchema>,
  check: AssertionCheck,
): Promise<string | null> {
  const response = parseAssertion(check.credential);

  if (response === null) {
    return null;
  }

  const passkey = await db
    .selectFrom('atc_passkey')
    .select(['id', 'public_key', 'counter', 'transports'])
    .where('id', '=', response.id)
    .executeTakeFirst();

  if (passkey === undefined) {
    return null;
  }

  const webAuthn = await loadWebAuthn();

  let verified: VerifiedAuthenticationResponse;

  try {
    verified = await webAuthn.verifyAuthenticationResponse({
      response,
      expectedChallenge: check.challenge,
      expectedOrigin: check.origin,
      expectedRPID: check.rpID,
      expectedType: 'webauthn.get',
      requireUserVerification: true,
      credential: {
        id: passkey.id,
        publicKey: new Uint8Array(Buffer.from(passkey.public_key, 'base64url')),
        counter: passkey.counter,
        transports: parseJSONStrings(passkey.transports) ?? [],
      },
    });
  } catch {
    return null;
  }

  if (!verified.verified || !verified.authenticationInfo.userVerified) {
    return null;
  }

  // Only while the passkey is still enrolled with the counter read above,
  // so a passkey removed during the verification, or a concurrent
  // assertion that stored a newer counter, makes this one fail.
  const stored = await db
    .updateTable('atc_passkey')
    .set({
      counter: verified.authenticationInfo.newCounter,
      last_used_at: new Date(check.now).toISOString(),
    })
    .where('id', '=', passkey.id)
    .where('counter', '=', passkey.counter)
    .executeTakeFirst();

  return stored.numUpdatedRows > 0n ? passkey.id : null;
}

const ASSERTION_REPLY = z.object({
  clientDataJSON: z.string(),
  authenticatorData: z.string(),
  signature: z.string(),
  userHandle: z.string().optional(),
});

const ASSERTION = z.object({
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal('public-key'),
  response: ASSERTION_REPLY,
});

// The posted JSON when it has the shape of an authentication response,
// else null; the verifier checks every value.
function parseAssertion(credential: string): AuthenticationResponseJSON | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(credential);
  } catch {
    return null;
  }

  const result = ASSERTION.safeParse(parsed);

  if (!result.success) {
    return null;
  }

  const { userHandle, ...response } = result.data.response;

  return {
    id: result.data.id,
    rawId: result.data.rawId,
    type: result.data.type,
    response: userHandle === undefined ? response : { ...response, userHandle },
    clientExtensionResults: {},
  };
}
