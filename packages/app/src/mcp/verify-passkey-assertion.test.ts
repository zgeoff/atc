import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubAuthenticator, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { openMCPAuthDatabase } from '../open-mcp-auth-database';
import { openMCPAuth } from './open-mcp-auth';
import { verifyPasskeyAssertion } from './verify-passkey-assertion';
import { verifyPasskeyRegistration } from './verify-passkey-registration';

// An authorization database, opened the way the server opens it, with the
// passkey of `authenticator` enrolled for the RP ID `atc.example`.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-verify-passkey-assertion-');

  const store = await openMCPAuth({
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openDatabase: openMCPAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  const authenticator = buildStubAuthenticator();

  const registration = await authenticator.create(
    { challenge: 'ZW5yb2xs', rp: { id: 'atc.example' }, user: { id: 'YXRjLW93bmVy' } },
    { origin: 'https://atc.example' },
  );

  const registered = await verifyPasskeyRegistration({
    credential: JSON.stringify(registration),
    challenge: 'ZW5yb2xs',
    origin: 'https://atc.example',
    rpID: 'atc.example',
  });

  invariant(registered !== null, 'the passkey did not register');

  await store.db
    .insertInto('atc_passkey')
    .values({
      id: registered.id,
      public_key: Buffer.from(registered.publicKey).toString('base64url'),
      counter: registered.counter,
      transports: '["internal"]',
      created_at: '2026-10-14T12:00:00.000Z',
      last_used_at: null,
    })
    .execute();

  return { db: store.db, authenticator };
}

test('it returns the id of the enrolled passkey an assertion verifies against and stores its counter and use', async () => {
  const ctx = await setupTest();

  const assertion = await ctx.authenticator.signAssertion(
    { challenge: 'c2lnbi1pbg', rpId: 'atc.example' },
    { origin: 'https://atc.example' },
  );

  const verified = await verifyPasskeyAssertion(ctx.db, {
    credential: JSON.stringify(assertion),
    challenge: 'c2lnbi1pbg',
    origin: 'https://atc.example',
    rpID: 'atc.example',
    now: Date.UTC(2026, 9, 14, 13, 0, 0),
  });

  expect(verified).toBe(ctx.authenticator.credentialID);

  const passkeyRows = await ctx.db
    .selectFrom('atc_passkey')
    .select(['counter', 'last_used_at'])
    .execute();

  expect(passkeyRows).toStrictEqual([{ counter: 1, last_used_at: '2026-10-14T13:00:00.000Z' }]);
});

test.each([
  ['another challenge', { challenge: 'b3RoZXI' }, {}],
  ['another origin', {}, { origin: 'https://elsewhere.example' }],
  ['another RP ID', {}, { rpID: 'elsewhere.example' }],
  ['an unverified user', {}, { userVerified: false }],
])('it refuses an assertion made for %s', async (_label, expected, ceremony) => {
  const ctx = await setupTest();

  const assertion = await ctx.authenticator.signAssertion(
    { challenge: 'c2lnbi1pbg', rpId: 'atc.example' },
    { origin: 'https://atc.example', ...ceremony },
  );

  const verified = await verifyPasskeyAssertion(ctx.db, {
    credential: JSON.stringify(assertion),
    challenge: 'c2lnbi1pbg',
    origin: 'https://atc.example',
    rpID: 'atc.example',
    now: Date.UTC(2026, 9, 14, 13, 0, 0),
    ...expected,
  });

  expect(verified).toBeNull();
});

test('it refuses an assertion from a passkey that is not enrolled', async () => {
  const ctx = await setupTest();

  const stranger = buildStubAuthenticator();

  await stranger.create(
    { challenge: 'ZW5yb2xs', rp: { id: 'atc.example' }, user: { id: 'YXRjLW93bmVy' } },
    { origin: 'https://atc.example' },
  );

  const assertion = await stranger.signAssertion(
    { challenge: 'c2lnbi1pbg', rpId: 'atc.example' },
    { origin: 'https://atc.example' },
  );

  const verified = await verifyPasskeyAssertion(ctx.db, {
    credential: JSON.stringify(assertion),
    challenge: 'c2lnbi1pbg',
    origin: 'https://atc.example',
    rpID: 'atc.example',
    now: Date.UTC(2026, 9, 14, 13, 0, 0),
  });

  expect(verified).toBeNull();
});

test("it refuses an assertion signed by another key under the enrolled passkey's id", async () => {
  const ctx = await setupTest();

  const forger = buildStubAuthenticator();

  await forger.create(
    { challenge: 'ZW5yb2xs', rp: { id: 'atc.example' }, user: { id: 'YXRjLW93bmVy' } },
    { origin: 'https://atc.example' },
  );

  const forged = await forger.signAssertion(
    { challenge: 'c2lnbi1pbg', rpId: 'atc.example' },
    { origin: 'https://atc.example' },
  );

  const verified = await verifyPasskeyAssertion(ctx.db, {
    credential: JSON.stringify({
      ...forged,
      id: ctx.authenticator.credentialID,
      rawId: ctx.authenticator.credentialID,
    }),
    challenge: 'c2lnbi1pbg',
    origin: 'https://atc.example',
    rpID: 'atc.example',
    now: Date.UTC(2026, 9, 14, 13, 0, 0),
  });

  expect(verified).toBeNull();
});

test('it refuses an assertion whose counter does not pass the stored one', async () => {
  const ctx = await setupTest();

  const assertion = await ctx.authenticator.signAssertion(
    { challenge: 'c2lnbi1pbg', rpId: 'atc.example' },
    { origin: 'https://atc.example' },
  );

  await ctx.db.updateTable('atc_passkey').set({ counter: 5 }).execute();

  const verified = await verifyPasskeyAssertion(ctx.db, {
    credential: JSON.stringify(assertion),
    challenge: 'c2lnbi1pbg',
    origin: 'https://atc.example',
    rpID: 'atc.example',
    now: Date.UTC(2026, 9, 14, 13, 0, 0),
  });

  expect(verified).toBeNull();
});

test.each([['not json'], ['{}'], ['{"id":"x","rawId":"x","type":"public-key","response":{}}']])(
  'it refuses the malformed credential %p',
  async (credential) => {
    const ctx = await setupTest();

    const verified = await verifyPasskeyAssertion(ctx.db, {
      credential,
      challenge: 'c2lnbi1pbg',
      origin: 'https://atc.example',
      rpID: 'atc.example',
      now: Date.UTC(2026, 9, 14, 13, 0, 0),
    });

    expect(verified).toBeNull();
  },
);

test('it passes only one of two assertions checked at once against the same stored counter', async () => {
  const ctx = await setupTest();

  const first = await ctx.authenticator.signAssertion(
    { challenge: 'Zmlyc3Q', rpId: 'atc.example' },
    { origin: 'https://atc.example' },
  );

  const second = await ctx.authenticator.signAssertion(
    { challenge: 'c2Vjb25k', rpId: 'atc.example' },
    { origin: 'https://atc.example' },
  );

  const results = await Promise.all([
    verifyPasskeyAssertion(ctx.db, {
      credential: JSON.stringify(first),
      challenge: 'Zmlyc3Q',
      origin: 'https://atc.example',
      rpID: 'atc.example',
      now: Date.UTC(2026, 9, 14, 13, 0, 0),
    }),
    verifyPasskeyAssertion(ctx.db, {
      credential: JSON.stringify(second),
      challenge: 'c2Vjb25k',
      origin: 'https://atc.example',
      rpID: 'atc.example',
      now: Date.UTC(2026, 9, 14, 13, 0, 0),
    }),
  ]);

  expect(results.filter((id) => id !== null)).toBeArrayOfSize(1);
});
