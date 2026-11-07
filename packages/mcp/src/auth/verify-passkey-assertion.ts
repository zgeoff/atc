import { parseJSONStrings } from '@atc/core';
import type {
  AuthenticationResponseJSON,
  VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { loadWebAuthn } from './load-web-authn';
import type { MCPAuthSchema } from './mcp-auth-schema';
import { updatePasskeyUse } from './update-passkey-use';

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

  const stored = await updatePasskeyUse(db, {
    id: passkey.id,
    counter: passkey.counter,
    newCounter: verified.authenticationInfo.newCounter,
    now: check.now,
  });

  return stored ? passkey.id : null;
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
