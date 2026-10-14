import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';

interface RegistrationCheck {
  // The credential JSON the enrollment page posted.
  readonly credential: string;

  // The challenge the page was given, which the caller has already taken.
  readonly challenge: string;
  readonly origin: string;
  readonly rpID: string;
}

/**
 * A passkey a registration created, ready to store.
 */
export interface RegisteredPasskey {
  readonly id: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly transports: readonly string[];
}

/**
 * The passkey a posted WebAuthn registration creates, when it parses and
 * verifies with the expected challenge, origin, and RP ID and with the user
 * verified, else null, never a throw. atc asks for no attestation, so it
 * trusts the new passkey through the enrollment token that came with it,
 * not through its maker.
 */
export async function verifyPasskeyRegistration(
  check: RegistrationCheck,
): Promise<RegisteredPasskey | null> {
  const response = parseRegistration(check.credential);

  if (response === null) {
    return null;
  }

  try {
    const verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: check.challenge,
      expectedOrigin: check.origin,
      expectedRPID: check.rpID,
      expectedType: 'webauthn.create',
      requireUserVerification: true,
    });

    if (!verified.verified || !verified.registrationInfo.userVerified) {
      return null;
    }

    const credential = verified.registrationInfo.credential;

    return {
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: response.response.transports ?? [],
    };
  } catch {
    return null;
  }
}

const TRANSPORTS: ReadonlySet<string> = new Set([
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
]);

const REGISTRATION_REPLY = z.object({
  clientDataJSON: z.string(),
  attestationObject: z.string(),
  transports: z.string().array().optional(),
});

const REGISTRATION = z.object({
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal('public-key'),
  response: REGISTRATION_REPLY,
});

// The posted JSON when it has the shape of a registration response, keeping
// only the transports WebAuthn defines, else null; the verifier checks
// every value.
function parseRegistration(credential: string): RegistrationResponseJSON | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(credential);
  } catch {
    return null;
  }

  const result = REGISTRATION.safeParse(parsed);

  if (!result.success) {
    return null;
  }

  const transports = (result.data.response.transports ?? []).filter((transport) =>
    TRANSPORTS.has(transport),
  );

  return {
    id: result.data.id,
    rawId: result.data.rawId,
    type: result.data.type,
    response: {
      clientDataJSON: result.data.response.clientDataJSON,
      attestationObject: result.data.response.attestationObject,
      transports,
    },
    clientExtensionResults: {},
  };
}
