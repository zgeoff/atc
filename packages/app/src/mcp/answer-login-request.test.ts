import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '@atc/protocol/client/daemon-client';
import { buildStubAuthenticator } from '@atc/test-utils/build-stub-authenticator';
import { buildStubClock } from '@atc/test-utils/build-stub-clock';
import { parsePasskeyPage } from '@atc/test-utils/parse-passkey-page';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { runPasskeyEnrollment } from '@atc/test-utils/run-passkey-enrollment';
import { runPasskeySignIn } from '@atc/test-utils/run-passkey-sign-in';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import invariant from 'tiny-invariant';
import { openMCPAuthDatabase } from '../open-mcp-auth-database';
import { createEnrollmentToken } from './create-enrollment-token';
import { openMCPAuth } from './open-mcp-auth';
import { ReconnectingCaller } from './reconnecting-caller';
import { resetPasskeys } from './reset-passkeys';
import { startMCPHTTPServer } from './start-mcp-http-server';

// `atc mcp --http` on a free port, on a clock that stands still unless a
// test advances it, with the owner's passkey enrolled on `authenticator`,
// one client `dots` whose id is `clientID`, and every request line and
// security event line printed after the enrollment collected. The
// authorization database is opened a second time the way `atc clients`
// opens it. Sign-in never reaches the daemon, so the caller points at a
// socket nothing listens on and never dials it.
async function setupTest() {
  const tmp = setupTempDir('atc-answer-login-');
  const dbPath = join(tmp.dir, 'mcp-auth.db');
  const requests: string[] = [];
  const security: string[] = [];
  const clock = buildStubClock(Date.now());

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const server = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: null,
    allowedHosts: [],
    dbPath,
    openAuthDatabase: openMCPAuthDatabase,
    printRequest: (line) => {
      requests.push(line);
    },
    printSecurity: (line) => {
      security.push(line);
    },
    clock,
  });

  registerTestCleanup(() => server.stop());

  const store = await openMCPAuth({ dbPath, openDatabase: openMCPAuthDatabase, origin: null });

  registerTestCleanup(() => store.close());

  const authenticator = buildStubAuthenticator();

  const enrollment = await createEnrollmentToken(store.db, clock.now());

  await runPasskeyEnrollment(server, enrollment.token, authenticator);

  // Every sign-in starts from an authorization, which needs a client.
  const created = await store.auth.api.createFixedClient({
    body: { name: 'dots', redirectURIs: ['https://dots.example/cb'] },
  });

  // The lines the enrollment printed are not part of any scenario.
  requests.length = 0;
  security.length = 0;

  return {
    url: server.url,
    origin: server.origin,
    clientID: created.clientID,
    authenticator,
    clock,
    store,
    requests,
    security,
  };
}

test('it signs the owner in with the enrolled passkey and sends the browser on to consent', async () => {
  const ctx = await setupTest();

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    state: 'state-1',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login);

  expect(signedIn.status).toBe(302);
  expect(new URL(signedIn.headers.get('location') ?? '/').pathname).toBe('/consent');

  expect(signedIn.headers.getSetCookie()).toSatisfyAny((line: string) =>
    line.includes('session_token='),
  );
});

test('it refuses the assertion of a passkey that was never enrolled', async () => {
  const ctx = await setupTest();

  const stranger = buildStubAuthenticator();

  await stranger.create(
    { challenge: 'c3RyYW5nZXI', rp: { id: '127.0.0.1' }, user: { id: 'YXRjLW93bmVy' } },
    { origin: ctx.origin },
  );

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(
    { url: ctx.url, origin: ctx.origin, authenticator: stranger },
    login,
  );

  expect(signedIn.status).toBe(400);
  expect(signedIn.headers.getSetCookie()).toBeEmpty();

  const html = await signedIn.text();

  expect(html).toInclude('That passkey did not sign you in.');
});

test('it offers no sign-in and refuses a posted assertion while no passkey is enrolled', async () => {
  const ctx = await setupTest();

  await resetPasskeys(ctx.store.db);

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  const page = await fetch(login);
  const html = await page.text();

  const posted = await fetch(`${ctx.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: login.search.slice(1), credential: '{}' }),
  });

  expect(html).toInclude('No passkey is enrolled, so nobody can sign in.');
  expect(html).not.toInclude('id="atc-passkey"');
  expect(posted.status).toBe(400);
  expect(posted.headers.getSetCookie()).toBeEmpty();
  expect(ctx.security.at(-1)).toInclude('"reason":"not_enrolled"');
});

test('it refuses an assertion posted a second time once it signed in', async () => {
  const ctx = await setupTest();

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  const loginPage = await fetch(login);
  const loginHTML = await loginPage.text();

  const ceremony = parsePasskeyPage(loginHTML);

  invariant(ceremony.mode === 'get', 'the login page asked to enroll');

  const assertion = await ctx.authenticator.get(ceremony.options, { origin: ctx.origin });

  const sendAssertion = () =>
    fetch(`${ctx.url}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        oauth_query: login.search.slice(1),
        credential: JSON.stringify(assertion),
      }),
    });

  const first = await sendAssertion();
  const replayed = await sendAssertion();

  expect(first.status).toBe(302);
  expect(replayed.status).toBe(400);
  expect(replayed.headers.getSetCookie()).toBeEmpty();
});

test('it refuses an assertion whose challenge a failed sign-in already took', async () => {
  const ctx = await setupTest();

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  const loginPage = await fetch(login);
  const loginHTML = await loginPage.text();

  const ceremony = parsePasskeyPage(loginHTML);

  invariant(ceremony.mode === 'get', 'the login page asked to enroll');

  const assertion = await ctx.authenticator.get(ceremony.options, { origin: ctx.origin });

  await fetch(`${ctx.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: login.search.slice(1), credential: '{}' }),
  });

  const late = await fetch(`${ctx.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: login.search.slice(1),
      credential: JSON.stringify(assertion),
    }),
  });

  expect(late.status).toBe(400);
  expect(late.headers.getSetCookie()).toBeEmpty();
});

test('it refuses an assertion signed more than five minutes after its page as expired', async () => {
  const ctx = await setupTest();

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  const loginPage = await fetch(login);
  const loginHTML = await loginPage.text();

  const ceremony = parsePasskeyPage(loginHTML);

  invariant(ceremony.mode === 'get', 'the login page asked to enroll');

  const assertion = await ctx.authenticator.get(ceremony.options, { origin: ctx.origin });

  ctx.clock.advance(300_000);

  const late = await fetch(`${ctx.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: login.search.slice(1),
      credential: JSON.stringify(assertion),
    }),
  });

  expect(late.status).toBe(400);

  const html = await late.text();

  expect(html).toInclude('The sign-in took too long.');
  expect(ctx.security.at(-1)).toInclude('"reason":"expired"');
});

test.each([
  ['another origin', { origin: 'https://elsewhere.example' }],
  ['another RP ID', { rpID: 'elsewhere.example' }],
  ['an unverified user', { userVerified: false }],
])('it refuses an assertion made for %s', async (_label, ceremony) => {
  const ctx = await setupTest();

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login, ceremony);

  expect(signedIn.status).toBe(400);
  expect(signedIn.headers.getSetCookie()).toBeEmpty();
  expect(ctx.security.at(-1)).toInclude('"reason":"assertion_failed"');
});

test("it refuses an assertion signed for one request's page when posted for another request", async () => {
  const ctx = await setupTest();

  const first = new URL(`${ctx.url}/oauth2/authorize`);

  first.search = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    state: 'state-1',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const second = new URL(first);

  second.searchParams.set('state', 'state-2');
  second.searchParams.set('scope', 'read kill');

  const firstStarted = await fetch(first, { redirect: 'manual' });

  const firstLogin = new URL(firstStarted.headers.get('location') ?? '/', ctx.url);

  const secondStarted = await fetch(second, { redirect: 'manual' });

  const secondLogin = new URL(secondStarted.headers.get('location') ?? '/', ctx.url);

  const firstPage = await fetch(firstLogin);
  const firstHTML = await firstPage.text();

  const firstCeremony = parsePasskeyPage(firstHTML);

  await fetch(secondLogin);

  invariant(firstCeremony.mode === 'get', 'the login page asked to enroll');

  const assertion = await ctx.authenticator.get(firstCeremony.options, { origin: ctx.origin });

  const crossed = await fetch(`${ctx.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: secondLogin.search.slice(1),
      credential: JSON.stringify(assertion),
    }),
  });

  expect(crossed.status).toBe(400);
  expect(crossed.headers.getSetCookie()).toBeEmpty();
});

test('it refuses the assertion of an earlier tab once a later tab opened the same login page', async () => {
  const ctx = await setupTest();

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  const loginPage = await fetch(login);
  const loginHTML = await loginPage.text();

  const earlier = parsePasskeyPage(loginHTML);

  await fetch(login);

  invariant(earlier.mode === 'get', 'the login page asked to enroll');

  const assertion = await ctx.authenticator.get(earlier.options, { origin: ctx.origin });

  const signedIn = await fetch(`${ctx.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: login.search.slice(1),
      credential: JSON.stringify(assertion),
    }),
  });

  expect(signedIn.status).toBe(400);
});

test('it shows the page with a fresh challenge after a failed sign-in and ends the request at the fifth', async () => {
  const ctx = await setupTest();

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  const answers = [];

  for (const attempt of [1, 2, 3, 4, 5]) {
    const answered = await fetch(`${ctx.url}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        oauth_query: login.search.slice(1),
        credential: `{"attempt":${attempt}}`,
      }),
    });

    answers.push({ status: answered.status, page: await answered.text() });
  }

  const retry = expect.toInclude('That passkey did not sign you in.');

  expect(answers).toStrictEqual([
    { status: 400, page: retry },
    { status: 400, page: retry },
    { status: 400, page: retry },
    { status: 400, page: retry },
    { status: 400, page: expect.toInclude('Too many failed sign-ins.') },
  ]);
});

test('it refuses the enrolled passkey once five failed sign-ins ended the request', async () => {
  const ctx = await setupTest();

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  const loginPage = await fetch(login);
  const loginHTML = await loginPage.text();

  const ceremony = parsePasskeyPage(loginHTML);

  invariant(ceremony.mode === 'get', 'the login page asked to enroll');

  const assertion = await ctx.authenticator.get(ceremony.options, { origin: ctx.origin });

  for (const attempt of [1, 2, 3, 4, 5]) {
    await fetch(`${ctx.url}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        oauth_query: login.search.slice(1),
        credential: `{"attempt":${attempt}}`,
      }),
    });
  }

  const right = await fetch(`${ctx.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: login.search.slice(1),
      credential: JSON.stringify(assertion),
    }),
  });

  expect(right.status).toBe(400);

  const html = await right.text();

  expect(html).toInclude('This approval expired or was already used.');
});

test('it signs nobody in with an approval code, whatever the code', async () => {
  const ctx = await setupTest();

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  await fetch(login);

  const answered = await fetch(`${ctx.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: login.search.slice(1), code: 'ABCD-EFGH' }),
  });

  expect(answered.status).toBe(400);
  expect(answered.headers.getSetCookie()).toBeEmpty();
  expect(ctx.security.at(-1)).toInclude('"reason":"assertion_failed","method":"passkey"');
});

test('it signs nobody in with any value its request lines and security events hold', async () => {
  const ctx = await setupTest();

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  await fetch(login);

  // Every word of every line the server printed while an authorization
  // waited on its login page.
  const words = [...ctx.requests, ...ctx.security].flatMap((line) => line.split(/[\s"{}:,[\]]+/u));
  const candidates = [...new Set(words.filter((word) => word.length >= 4))];
  const answers = [];

  // Each candidate goes to a login page of its own, past the limit on
  // starts, so no lock from an earlier candidate decides its answer.
  for (const candidate of candidates) {
    ctx.clock.advance(7000);

    const fresh = await fetch(authorize, { redirect: 'manual' });

    const page = new URL(fresh.headers.get('location') ?? '/', ctx.url);

    await fetch(page);

    const answered = await fetch(`${ctx.url}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        oauth_query: page.search.slice(1),
        code: candidate,
        credential: candidate,
      }),
    });

    answers.push({ status: answered.status, cookies: answered.headers.getSetCookie() });
  }

  expect(candidates.length).toBeGreaterThan(10);
  expect(answers.map((answer) => answer.status)).toSatisfyAll((status: number) => status === 400);
  expect(answers.flatMap((answer) => answer.cookies)).toBeEmpty();
});

test('it writes a failed sign-in as a failed passkey owner sign-in with the start correlation id', async () => {
  const ctx = await setupTest();

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  await runPasskeySignIn(ctx, login, { origin: 'https://elsewhere.example' });

  const correlationID = /"correlationID":"(?<id>[^"]+)"/u.exec(ctx.security[0] ?? '')?.groups?.[
    'id'
  ];

  expect(
    JSON.parse(`[${ctx.security.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toStrictEqual([
    expect.objectContaining({ kind: 'authorize_started', correlationID: expect.toBeString() }),
    {
      v: 1,
      ts: new Date(ctx.clock.now()).toISOString(),
      kind: 'owner_auth',
      outcome: 'failed',
      reason: 'assertion_failed',
      method: 'passkey',
      route: '/login',
      client: { id: ctx.clientID, name: 'dots' },
      correlationID: expect.toBeOneOf([correlationID]),
      peer: { address: '127.0.0.1', provenance: 'socket' },
      userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
    },
  ]);
});

test('it writes the fifth failed sign-in as a locked passkey owner sign-in', async () => {
  const ctx = await setupTest();

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  for (const attempt of [1, 2, 3, 4, 5]) {
    await fetch(`${ctx.url}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        oauth_query: login.search.slice(1),
        credential: `{"attempt":${attempt}}`,
      }),
    });
  }

  expect(JSON.parse(ctx.security.at(-1)?.slice('atc security '.length) ?? 'null')).toMatchObject({
    kind: 'owner_auth',
    outcome: 'failed',
    reason: 'locked',
    method: 'passkey',
  });
});
