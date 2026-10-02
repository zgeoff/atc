import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { openMCPAuth } from './open-mcp-auth';
import { verifyOAuthQuery } from './verify-oauth-query';

async function setupTest() {
  const tmp = setupTempDir('atc-verify-oauth-query-');

  const store = await openMCPAuth({
    dbPath: join(tmp.dir, 'mcp-auth.db'),
    origin: 'https://atc.example',
  });

  const context = await store.auth.$context;

  return {
    store,
    secret: context.secret,
    async [Symbol.asyncDispose]() {
      await store.close();
      await tmp[Symbol.asyncDispose]();
    },
  };
}

test('it accepts the query better-auth signs for the login page', async () => {
  await using auth = await setupTest();

  const created = await auth.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const authorize = new URL('https://atc.example/oauth2/authorize');

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: created.clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    state: 'state-1',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const answered = await auth.store.auth.handler(new Request(authorize.href));

  const login = new URL(answered.headers.get('location') ?? '/', 'https://atc.example');

  const verified = await verifyOAuthQuery(login.search.slice(1), auth.secret);

  expect(login.pathname).toBe('/login');
  expect(verified).toBeTrue();
});

test('it refuses a signed query with one parameter changed', async () => {
  await using auth = await setupTest();

  const created = await auth.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const authorize = new URL('https://atc.example/oauth2/authorize');

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: created.clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    state: 'state-1',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const answered = await auth.store.auth.handler(new Request(authorize.href));

  const login = new URL(answered.headers.get('location') ?? '/', 'https://atc.example');

  login.searchParams.set('state', 'state-2');

  const verified = await verifyOAuthQuery(login.search.slice(1), auth.secret);

  expect(verified).toBeFalse();
});

test.each([
  ['client_id=c1&exp=99999999999'],
  ['client_id=c1&exp=99999999999&sig='],
  ['client_id=c1&exp=99999999999&sig=a&sig=b'],
])('it refuses the query %p without one valid signature', async (query) => {
  await using auth = await setupTest();

  const verified = await verifyOAuthQuery(query, auth.secret);

  expect(verified).toBeFalse();
});
