import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import {
  buildStubAuthenticator,
  buildStubClock,
  parsePasskeyPage,
  registerTestCleanup,
  runPasskeyEnrollment,
  runPasskeySignIn,
  setupTempDir,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { startMCPHTTPServer } from '../http/start-mcp-http-server';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { TransportCaller } from '../tools/transport-caller';
import { createEnrollmentToken } from './create-enrollment-token';
import { openMCPAuth } from './open-mcp-auth';
import { readPasskeyViews } from './read-passkey-views';
import { resetPasskeys } from './reset-passkeys';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-answer-enroll-');
  const dbPath = join(temporaryDirectory.path, 'mcp-auth.db');
  const security: string[] = [];
  const clock = buildStubClock(Date.now());

  // enrollment never reaches the daemon, so nothing listens on this socket.
  const caller = new TransportCaller(
    join(temporaryDirectory.path, 'daemon.sock'),
    'atc/test-build',
    (path) => openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const server = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: null,
    allowedHosts: [],
    trustForwardedFrom: [],
    dbPath,
    openAuthDatabase: openTestAuthDatabase,
    printRequest: () => {},
    printSecurity: (line) => {
      security.push(line);
    },
    clock,
  });

  registerTestCleanup(() => server.stop());

  const store = await openMCPAuth({ dbPath, openDatabase: openTestAuthDatabase, origin: null });

  registerTestCleanup(() => store.close());

  return { url: server.url, origin: server.origin, clock, store, security };
}

test('it enrolls a passkey with a minted token and signs nobody in doing so', async () => {
  const ctx = await setupTest();

  const authenticator = buildStubAuthenticator();

  const enrollment = await createEnrollmentToken(ctx.store.db, ctx.clock.now());

  const asked = await fetch(`${ctx.url}/enroll`, {
    method: 'POST',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: enrollment.token }),
  });

  const html = await asked.text();

  const ceremony = parsePasskeyPage(html);

  invariant(ceremony.mode === 'create', 'the enrollment page asked for a sign-in');

  const registration = await authenticator.create(ceremony.options, { origin: ctx.origin });

  const enrolled = await fetch(`${ctx.url}/enroll`, {
    method: 'POST',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: enrollment.token,
      credential: JSON.stringify(registration),
    }),
  });

  expect(enrolled.status).toBe(200);
  expect(enrolled.headers.getSetCookie()).toBeEmpty();

  const passkeys = await readPasskeyViews(ctx.store.db);

  expect(passkeys).toStrictEqual([
    { id: authenticator.credentialID, createdAt: expect.toBeString(), lastUsedAt: null },
  ]);
});

test('it asks for a passkey that requires user verification and is discoverable, for its own RP ID', async () => {
  const ctx = await setupTest();
  const enrollment = await createEnrollmentToken(ctx.store.db, ctx.clock.now());

  const asked = await fetch(`${ctx.url}/enroll`, {
    method: 'POST',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: enrollment.token }),
  });

  const html = await asked.text();

  const block = /id="atc-passkey">(?<json>[^<]*)</u.exec(html)?.groups?.['json'] ?? 'null';

  expect(JSON.parse(block)).toMatchObject({
    mode: 'create',
    options: {
      rp: { id: '127.0.0.1', name: 'atc' },
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      attestation: 'none',
      excludeCredentials: [],
    },
  });

  expect(asked.headers.get('content-security-policy')).toMatch(/script-src 'sha256-[\w+/=]+';/u);
});

test('it refuses a token it never minted and writes an invalid_token event', async () => {
  const ctx = await setupTest();

  const asked = await fetch(`${ctx.url}/enroll`, {
    method: 'POST',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'atc-enroll-made-up-by-a-visitor' }),
  });

  expect(asked.status).toBe(400);

  const html = await asked.text();

  expect(html).not.toInclude('id="atc-passkey"');

  expect(JSON.parse(ctx.security.at(-1)?.slice('atc security '.length) ?? 'null')).toMatchObject({
    kind: 'owner_auth',
    outcome: 'failed',
    reason: 'invalid_token',
    method: 'enrollment_token',
    route: '/enroll',
  });
});

test('it refuses a registration posted without a token, storing no passkey', async () => {
  const ctx = await setupTest();

  const authenticator = buildStubAuthenticator();

  const registration = await authenticator.create(
    { challenge: 'bm8tdG9rZW4', rp: { id: '127.0.0.1' }, user: { id: 'YXRjLW93bmVy' } },
    { origin: ctx.origin },
  );

  const enrolled = await fetch(`${ctx.url}/enroll`, {
    method: 'POST',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential: JSON.stringify(registration) }),
  });

  expect(enrolled.status).toBe(400);

  const passkeys = await readPasskeyViews(ctx.store.db);

  expect(passkeys).toBeEmpty();
});

test('it refuses a token that already enrolled a passkey', async () => {
  const ctx = await setupTest();
  const enrollment = await createEnrollmentToken(ctx.store.db, ctx.clock.now());

  await runPasskeyEnrollment(ctx, enrollment.token, buildStubAuthenticator());

  const again = runPasskeyEnrollment(ctx, enrollment.token, buildStubAuthenticator());

  expect(again).rejects.toThrowWithMessage(
    Error,
    'the enrollment token did not reach the passkey prompt: 400',
  );
});

test('it refuses a token past its 15 minutes', async () => {
  const ctx = await setupTest();
  const enrollment = await createEnrollmentToken(ctx.store.db, ctx.clock.now() - 900_000);

  const asked = await fetch(`${ctx.url}/enroll`, {
    method: 'POST',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: enrollment.token }),
  });

  expect(asked.status).toBe(400);
});

test('it refuses a token minted before a reset', async () => {
  const ctx = await setupTest();
  const enrollment = await createEnrollmentToken(ctx.store.db, ctx.clock.now());

  await resetPasskeys(ctx.store.db);

  const enrolling = runPasskeyEnrollment(ctx, enrollment.token, buildStubAuthenticator());

  expect(enrolling).rejects.toThrowWithMessage(
    Error,
    'the enrollment token did not reach the passkey prompt: 400',
  );
});

test.each([
  ['another origin', { origin: 'https://elsewhere.example' }],
  ['another RP ID', { rpID: 'elsewhere.example' }],
  ['an unverified user', { userVerified: false }],
])('it refuses a registration made for %s', async (_label, override) => {
  const ctx = await setupTest();
  const enrollment = await createEnrollmentToken(ctx.store.db, ctx.clock.now());

  const asked = await fetch(`${ctx.url}/enroll`, {
    method: 'POST',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: enrollment.token }),
  });

  const html = await asked.text();

  const ceremony = parsePasskeyPage(html);

  invariant(ceremony.mode === 'create', 'the enrollment page asked for a sign-in');

  const registration = await buildStubAuthenticator().create(ceremony.options, {
    origin: ctx.origin,
    ...override,
  });

  const refused = await fetch(`${ctx.url}/enroll`, {
    method: 'POST',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: enrollment.token,
      credential: JSON.stringify(registration),
    }),
  });

  expect(refused.status).toBe(400);

  const passkeys = await readPasskeyViews(ctx.store.db);

  expect(passkeys).toBeEmpty();
  expect(ctx.security.at(-1)).toInclude('"reason":"assertion_failed"');
});

test('it keeps a token usable after it refused a registration made with it', async () => {
  const ctx = await setupTest();
  const enrollment = await createEnrollmentToken(ctx.store.db, ctx.clock.now());

  const asked = await fetch(`${ctx.url}/enroll`, {
    method: 'POST',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: enrollment.token }),
  });

  const html = await asked.text();

  const ceremony = parsePasskeyPage(html);

  invariant(ceremony.mode === 'create', 'the enrollment page asked for a sign-in');

  const registration = await buildStubAuthenticator().create(ceremony.options, {
    origin: 'https://elsewhere.example',
  });

  await fetch(`${ctx.url}/enroll`, {
    method: 'POST',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: enrollment.token,
      credential: JSON.stringify(registration),
    }),
  });

  await runPasskeyEnrollment(ctx, enrollment.token, buildStubAuthenticator());

  const passkeys = await readPasskeyViews(ctx.store.db);

  expect(passkeys).toBeArrayOfSize(1);
});

test("it refuses a registration signed for another token's challenge", async () => {
  const ctx = await setupTest();
  const mine = await createEnrollmentToken(ctx.store.db, ctx.clock.now());
  const other = await createEnrollmentToken(ctx.store.db, ctx.clock.now());

  const askedOther = await fetch(`${ctx.url}/enroll`, {
    method: 'POST',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: other.token }),
  });

  await fetch(`${ctx.url}/enroll`, {
    method: 'POST',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: mine.token }),
  });

  const html = await askedOther.text();

  const ceremony = parsePasskeyPage(html);

  invariant(ceremony.mode === 'create', 'the enrollment page asked for a sign-in');

  const registration = await buildStubAuthenticator().create(ceremony.options, {
    origin: ctx.origin,
  });

  const crossed = await fetch(`${ctx.url}/enroll`, {
    method: 'POST',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: mine.token, credential: JSON.stringify(registration) }),
  });

  expect(crossed.status).toBe(400);

  const passkeys = await readPasskeyViews(ctx.store.db);

  expect(passkeys).toBeEmpty();
});

test('it refuses a registration signed more than five minutes after its page', async () => {
  const ctx = await setupTest();
  const enrollment = await createEnrollmentToken(ctx.store.db, ctx.clock.now());

  const asked = await fetch(`${ctx.url}/enroll`, {
    method: 'POST',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: enrollment.token }),
  });

  const askedHTML = await asked.text();

  const ceremony = parsePasskeyPage(askedHTML);

  invariant(ceremony.mode === 'create', 'the enrollment page asked for a sign-in');

  const registration = await buildStubAuthenticator().create(ceremony.options, {
    origin: ctx.origin,
  });

  ctx.clock.advance(300_000);

  const late = await fetch(`${ctx.url}/enroll`, {
    method: 'POST',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: enrollment.token,
      credential: JSON.stringify(registration),
    }),
  });

  expect(late.status).toBe(400);

  const html = await late.text();

  expect(html).toInclude('The enrollment took too long.');
});

test('it lets each of two enrolled passkeys sign in, so a second device covers a lost one', async () => {
  const ctx = await setupTest();

  const phone = buildStubAuthenticator();
  const laptop = buildStubAuthenticator();

  const phoneEnrollment = await createEnrollmentToken(ctx.store.db, ctx.clock.now());

  await runPasskeyEnrollment(ctx, phoneEnrollment.token, phone);

  const laptopEnrollment = await createEnrollmentToken(ctx.store.db, ctx.clock.now());

  await runPasskeyEnrollment(ctx, laptopEnrollment.token, laptop);

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'dots', redirectURIs: ['https://dots.example/cb'] },
  });

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: created.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const firstStarted = await fetch(authorize, { redirect: 'manual' });

  const firstLogin = new URL(firstStarted.headers.get('location') ?? '/', ctx.url);

  authorize.searchParams.set('state', 'second');

  const secondStarted = await fetch(authorize, { redirect: 'manual' });

  const secondLogin = new URL(secondStarted.headers.get('location') ?? '/', ctx.url);

  const byPhone = await runPasskeySignIn({ ...ctx, authenticator: phone }, firstLogin);
  const byLaptop = await runPasskeySignIn({ ...ctx, authenticator: laptop }, secondLogin);

  expect(byPhone.status).toBe(302);
  expect(byLaptop.status).toBe(302);
});

test.each([
  ['DELETE', '/enroll'],
  ['PUT', '/enroll'],
  ['POST', '/passkeys'],
  ['DELETE', '/passkeys'],
  ['POST', '/passkeys/reset'],
  ['POST', '/recover'],
  ['POST', '/atc/sign-in-owner'],
  ['POST', '/sign-up/email'],
  ['POST', '/passkey/generate-register-options'],
])('it offers no route at %s %s that changes passkeys', async (method, path) => {
  const ctx = await setupTest();

  const authenticator = buildStubAuthenticator();

  const enrollment = await createEnrollmentToken(ctx.store.db, ctx.clock.now());

  await runPasskeyEnrollment(ctx, enrollment.token, authenticator);

  const answered = await fetch(`${ctx.url}${path}`, {
    method,
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
  });

  expect(answered.status).toBe(404);

  const passkeys = await readPasskeyViews(ctx.store.db);

  expect(passkeys).toStrictEqual([
    { id: authenticator.credentialID, createdAt: expect.toBeString(), lastUsedAt: null },
  ]);
});

test('it refuses an enrollment form posted from another origin', async () => {
  const ctx = await setupTest();
  const enrollment = await createEnrollmentToken(ctx.store.db, ctx.clock.now());

  const asked = await fetch(`${ctx.url}/enroll`, {
    method: 'POST',
    headers: {
      origin: 'https://evil.example',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ token: enrollment.token }),
  });

  expect(asked.status).toBe(403);
});
