import type {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

export interface WebAuthn {
  readonly verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
  readonly verifyRegistrationResponse: typeof verifyRegistrationResponse;
}

export async function loadWebAuthn(): Promise<WebAuthn> {
  // the library imports this polyfill itself, but a compiled binary's bundle runs
  // its certificate code before that import, so the polyfill loads first.
  await import('reflect-metadata');

  return import('@simplewebauthn/server');
}
