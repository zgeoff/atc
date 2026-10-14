import { expect, test } from 'bun:test';
import { buildStubAuthenticator } from '@atc/test-utils/build-stub-authenticator';
import { verifyPasskeyRegistration } from './verify-passkey-registration';

test('it returns the passkey a verified registration creates', async () => {
  const authenticator = buildStubAuthenticator();

  const registration = await authenticator.create(
    { challenge: 'Y2hhbGxlbmdl', rp: { id: 'atc.example' }, user: { id: 'YXRjLW93bmVy' } },
    { origin: 'https://atc.example' },
  );

  const registered = await verifyPasskeyRegistration({
    credential: JSON.stringify(registration),
    challenge: 'Y2hhbGxlbmdl',
    origin: 'https://atc.example',
    rpID: 'atc.example',
  });

  expect(registered).toMatchObject({
    id: authenticator.credentialID,
    counter: 0,
    transports: ['internal'],
  });

  expect(registered?.publicKey).toBeInstanceOf(Uint8Array);
});

test.each([
  ['another challenge', { challenge: 'b3RoZXI' }, {}],
  ['another origin', {}, { origin: 'https://elsewhere.example' }],
  ['another RP ID', {}, { rpID: 'elsewhere.example' }],
  ['an unverified user', {}, { userVerified: false }],
])('it returns null for a registration made for %s', async (_label, expected, ceremony) => {
  const registration = await buildStubAuthenticator().create(
    { challenge: 'Y2hhbGxlbmdl', rp: { id: 'atc.example' }, user: { id: 'YXRjLW93bmVy' } },
    { origin: 'https://atc.example', ...ceremony },
  );

  const registered = await verifyPasskeyRegistration({
    credential: JSON.stringify(registration),
    challenge: 'Y2hhbGxlbmdl',
    origin: 'https://atc.example',
    rpID: 'atc.example',
    ...expected,
  });

  expect(registered).toBeNull();
});

test.each([['not json'], ['{}'], ['{"id":"x","rawId":"x","type":"public-key","response":{}}']])(
  'it returns null for the malformed credential %p',
  async (credential) => {
    const registered = await verifyPasskeyRegistration({
      credential,
      challenge: 'Y2hhbGxlbmdl',
      origin: 'https://atc.example',
      rpID: 'atc.example',
    });

    expect(registered).toBeNull();
  },
);

test('it keeps only the transports WebAuthn defines', async () => {
  const registration = await buildStubAuthenticator().create(
    { challenge: 'Y2hhbGxlbmdl', rp: { id: 'atc.example' }, user: { id: 'YXRjLW93bmVy' } },
    { origin: 'https://atc.example' },
  );

  const registered = await verifyPasskeyRegistration({
    credential: JSON.stringify({
      ...registration,
      response: { ...registration.response, transports: ['usb', '<script>'] },
    }),
    challenge: 'Y2hhbGxlbmdl',
    origin: 'https://atc.example',
    rpID: 'atc.example',
  });

  expect(registered?.transports).toStrictEqual(['usb']);
});
