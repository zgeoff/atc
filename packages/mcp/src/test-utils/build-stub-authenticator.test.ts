import { expect, test } from 'bun:test';
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import invariant from 'tiny-invariant';
import { buildStubAuthenticator } from './build-stub-authenticator';

test('it makes a registration a relying party verifies with user verification', async () => {
  const authenticator = buildStubAuthenticator();

  const registration = await authenticator.create(
    { challenge: 'Y2hhbGxlbmdlLW9uZQ', rp: { id: 'passkeys.example' }, user: { id: 'b3duZXI' } },
    { origin: 'https://passkeys.example' },
  );

  const verified = await verifyRegistrationResponse({
    response: { ...registration, response: { ...registration.response, transports: ['internal'] } },
    expectedChallenge: 'Y2hhbGxlbmdlLW9uZQ',
    expectedOrigin: 'https://passkeys.example',
    expectedRPID: 'passkeys.example',
    requireUserVerification: true,
  });

  expect(verified.registrationInfo?.credential.id).toBe(authenticator.credentialID);
});

test('it signs an assertion that verifies against the registered key', async () => {
  const authenticator = buildStubAuthenticator();

  const registration = await authenticator.create(
    { challenge: 'Y2hhbGxlbmdlLW9uZQ', rp: { id: 'passkeys.example' }, user: { id: 'b3duZXI' } },
    { origin: 'https://passkeys.example' },
  );

  const registered = await verifyRegistrationResponse({
    response: { ...registration, response: { ...registration.response, transports: ['internal'] } },
    expectedChallenge: 'Y2hhbGxlbmdlLW9uZQ',
    expectedOrigin: 'https://passkeys.example',
    expectedRPID: 'passkeys.example',
  });

  invariant(registered.verified, 'the registration did not verify');

  const assertion = await authenticator.signAssertion(
    { challenge: 'Y2hhbGxlbmdlLXR3bw', rpId: 'passkeys.example' },
    { origin: 'https://passkeys.example' },
  );

  const verified = await verifyAuthenticationResponse({
    response: assertion,
    expectedChallenge: 'Y2hhbGxlbmdlLXR3bw',
    expectedOrigin: 'https://passkeys.example',
    expectedRPID: 'passkeys.example',
    credential: registered.registrationInfo.credential,
    requireUserVerification: true,
  });

  expect(verified.authenticationInfo.newCounter).toBe(1);
});

test('it writes the ceremony it is given into the assertion', async () => {
  const authenticator = buildStubAuthenticator();

  await authenticator.create(
    { challenge: 'Y2hhbGxlbmdlLW9uZQ', rp: { id: 'passkeys.example' }, user: { id: 'b3duZXI' } },
    { origin: 'https://passkeys.example' },
  );

  const assertion = await authenticator.signAssertion(
    { challenge: 'Y2hhbGxlbmdlLXR3bw', rpId: 'passkeys.example' },
    { origin: 'https://elsewhere.example', rpID: 'elsewhere.example', userVerified: false },
  );

  const authenticatorData = Buffer.from(assertion.response.authenticatorData, 'base64url');

  expect(
    JSON.parse(Buffer.from(assertion.response.clientDataJSON, 'base64url').toString()),
  ).toStrictEqual({
    type: 'webauthn.get',
    challenge: 'Y2hhbGxlbmdlLXR3bw',
    origin: 'https://elsewhere.example',
    crossOrigin: false,
  });

  expect(authenticatorData.subarray(0, 32).toString('hex')).toBe(
    new Bun.CryptoHasher('sha256').update('elsewhere.example').digest('hex'),
  );

  expect(authenticatorData[32]).toBe(0x01);
});

test('it refuses to sign before it holds a credential', () => {
  const authenticator = buildStubAuthenticator();

  expect(
    authenticator.signAssertion(
      { challenge: 'Y2hhbGxlbmdlLXR3bw', rpId: 'passkeys.example' },
      { origin: 'https://passkeys.example' },
    ),
  ).rejects.toThrow('holds no credential');
});
