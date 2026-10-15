import type {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

/**
 * The WebAuthn verifiers atc uses.
 */
export interface WebAuthn {
  readonly verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
  readonly verifyRegistrationResponse: typeof verifyRegistrationResponse;
}

/**
 * The WebAuthn library, loaded once the Reflect metadata polyfill its
 * certificate code needs is in place. The library imports the polyfill
 * itself, but a compiled binary's bundle starts the certificate code before
 * that import runs, so the polyfill loads first here.
 */
export async function loadWebAuthn(): Promise<WebAuthn> {
  await import('reflect-metadata');

  return import('@simplewebauthn/server');
}
