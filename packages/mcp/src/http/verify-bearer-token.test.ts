import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { isRecord } from '@atc/core';
import {
  buildStubAuthenticator,
  buildStubClock,
  readJSONRecord,
  registerTestCleanup,
  runMCPTokenGrant,
  runPasskeyEnrollment,
  sendModernMCPRequest,
  setupTempDir,
} from '@atc/test-utils';
import type { GrantScope } from '@atcx/contract';
import { buildServiceClientID } from '../auth/build-service-client-id';
import { createEnrollmentToken } from '../auth/create-enrollment-token';
import { isServiceClientID } from '../auth/is-service-client-id';
import { openMCPAuth } from '../auth/open-mcp-auth';
import { buildStubFleetCaller } from '../testing/build-stub-fleet-caller';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { startMCPHTTPServer } from './start-mcp-http-server';

interface ServiceClientFixture {
  readonly name: string;
  readonly scopes: readonly GrantScope[];
  readonly tokens: readonly string[];
}

// Without a file, the server loads no service tokens. With one, its resource
// is the public URL's, so the file can name it before the server binds.
async function setupTest(file: readonly ServiceClientFixture[] | null) {
  const temporaryDirectory = setupTempDir('atc-mcp-service-tokens-');
  const dbPath = join(temporaryDirectory.path, 'mcp-auth.db');
  const security: string[] = [];
  const caller = buildStubFleetCaller();
  const clock = buildStubClock(Date.now());

  const server = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: 'https://atc.example.com',
    allowedHosts: [],
    trustForwardedFrom: [],
    dbPath,
    openAuthDatabase: openTestAuthDatabase,
    printRequest: () => {},
    printSecurity: (line) => {
      security.push(line);
    },
    clock,
    ...(file === null
      ? {}
      : { serviceTokens: { resource: 'https://atc.example.com/mcp', clients: file } }),
  });

  registerTestCleanup(() => server.stop());

  const store = await openMCPAuth({
    dbPath,
    openDatabase: openTestAuthDatabase,
    origin: server.origin,
  });

  registerTestCleanup(() => store.close());

  const authenticator = buildStubAuthenticator();

  const enrollment = await createEnrollmentToken(store.db, clock.now());

  await runPasskeyEnrollment(server, enrollment.token, authenticator);

  security.length = 0;

  const grantTarget = { authenticator, url: server.url, origin: server.origin };

  return {
    caller,
    security,
    store,
    url: server.url,
    post: (token: string, message: Readonly<Record<string, unknown>>) =>
      globalThis.fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...message }),
      }),
    issueOAuthToken: async (): Promise<string> => {
      const created = await store.auth.api.createFixedClient({
        body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
      });

      const grant = await runMCPTokenGrant(grantTarget, {
        clientID: created.clientID,
        redirectURI: 'https://claude.ai/api/mcp/auth_callback',
        scope: 'read',
        ticked: ['read'],
      });

      return grant.accessToken;
    },
  };
}

test.each([[`atcs_${'r'.repeat(40)}`], [`atcs_${'s'.repeat(40)}`]])(
  'it lists the tools of a client with two tokens during a rotation (%p)',
  async (token) => {
    const ctx = await setupTest([
      {
        name: 'reader',
        scopes: ['read'],
        tokens: [`atcs_${'r'.repeat(40)}`, `atcs_${'s'.repeat(40)}`],
      },
    ]);

    const answered = await ctx.post(token, { method: 'tools/list' });
    const body = await readJSONRecord(answered);

    expect(answered.status).toBe(200);

    expect(body).toStrictEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: expect.toSatisfyAll((tool: unknown) => isRecord(tool)) },
    });
  },
);

test('it lists atc_sessions_list for a service token that holds read', async () => {
  const ctx = await setupTest([
    { name: 'reader', scopes: ['read'], tokens: [`atcs_${'r'.repeat(40)}`] },
  ]);

  const answered = await ctx.post(`atcs_${'r'.repeat(40)}`, { method: 'tools/list' });
  const body = await readJSONRecord(answered);

  expect(JSON.stringify(body)).toContain('"name":"atc_sessions_list"');
});

test('it passes a service client to the daemon as service:<name> in the legacy revision', async () => {
  const ctx = await setupTest([
    { name: 'reader', scopes: ['read'], tokens: [`atcs_${'r'.repeat(40)}`] },
  ]);

  await ctx.post(`atcs_${'r'.repeat(40)}`, {
    method: 'tools/call',
    params: { name: 'atc_sessions_list', arguments: {} },
  });

  expect(ctx.caller.requests.map((request) => request.principal)).toStrictEqual([
    { id: 'service:reader', name: 'service:reader' },
  ]);
});

test('it passes a service client to the daemon as service:<name> in the stateless revision', async () => {
  const ctx = await setupTest([
    { name: 'sender', scopes: ['read', 'message'], tokens: [`atcs_${'m'.repeat(40)}`] },
  ]);

  await sendModernMCPRequest(ctx.url, `atcs_${'m'.repeat(40)}`, 'tools/call', {
    name: 'atc_sessions_list',
    arguments: {},
  });

  expect(ctx.caller.requests.map((request) => request.principal)).toStrictEqual([
    { id: 'service:sender', name: 'service:sender' },
  ]);
});

test('it refuses a tool that needs message to a service token that holds read alone', async () => {
  const ctx = await setupTest([
    { name: 'reader', scopes: ['read'], tokens: [`atcs_${'r'.repeat(40)}`] },
  ]);

  const answered = await ctx.post(`atcs_${'r'.repeat(40)}`, {
    method: 'tools/call',
    params: { name: 'atc_message_send', arguments: { session: 'abc', text: 'hi' } },
  });

  expect(answered.status).toBe(403);

  expect(answered.headers.get('www-authenticate')).toStartWith(
    'Bearer error="insufficient_scope", error_description="Insufficient scope", scope="message"',
  );

  expect(ctx.caller.requests).toStrictEqual([]);
});

test('it refuses an event method to a service token without read', async () => {
  const ctx = await setupTest([
    { name: 'writer', scopes: ['message'], tokens: [`atcs_${'n'.repeat(40)}`] },
  ]);

  const answered = await sendModernMCPRequest(ctx.url, `atcs_${'n'.repeat(40)}`, 'events/list');

  expect(answered.status).toBe(403);

  expect(answered.body).toStrictEqual({
    error: 'insufficient_scope',
    error_description: 'Insufficient scope',
  });
});

test('it refuses an unlisted service token and records the refused bearer without the token', async () => {
  const ctx = await setupTest([
    { name: 'reader', scopes: ['read'], tokens: [`atcs_${'r'.repeat(40)}`] },
  ]);

  const answered = await ctx.post(`atcs_${'u'.repeat(40)}`, { method: 'ping' });

  expect(answered.status).toBe(401);
  expect(answered.headers.get('www-authenticate')).toContain('error="invalid_token"');

  expect(ctx.security).toStrictEqual([
    expect.stringMatching(
      /^atc security \{.*"kind":"bearer","outcome":"rejected","reason":"invalid_token"/u,
    ),
  ]);

  expect(ctx.security).toSatisfyAll((line: string) => !line.includes('atcs_'));
});

test('it refuses a service token when the gateway loaded no token file', async () => {
  const ctx = await setupTest(null);
  const answered = await ctx.post(`atcs_${'r'.repeat(40)}`, { method: 'ping' });

  expect(answered.status).toBe(401);
  expect(answered.headers.get('www-authenticate')).toContain('error="invalid_token"');
});

test('it serves an OAuth access token that has no service prefix', async () => {
  const ctx = await setupTest([
    { name: 'reader', scopes: ['read'], tokens: [`atcs_${'r'.repeat(40)}`] },
  ]);

  const accessToken = await ctx.issueOAuthToken();
  const answered = await ctx.post(accessToken, { method: 'ping' });

  expect(answered.status).toBe(200);
});

test('it refuses a valid OAuth access token that is given the service prefix', async () => {
  const ctx = await setupTest([
    { name: 'reader', scopes: ['read'], tokens: [`atcs_${'r'.repeat(40)}`] },
  ]);

  const accessToken = await ctx.issueOAuthToken();
  const answered = await ctx.post(`atcs_${accessToken}`, { method: 'ping' });

  expect(answered.status).toBe(401);
});

test('it refuses a service token as a refresh token at the token endpoint', async () => {
  const ctx = await setupTest([
    { name: 'reader', scopes: ['read'], tokens: [`atcs_${'r'.repeat(40)}`] },
  ]);

  const refreshed = await globalThis.fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: `atcs_${'r'.repeat(40)}`,
    }),
  });

  expect(refreshed.status).toBeGreaterThanOrEqual(400);
});

test('it refuses to start when the token file is for another resource', () => {
  const temporaryDirectory = setupTempDir('atc-mcp-service-tokens-');

  const started = startMCPHTTPServer({
    caller: buildStubFleetCaller(),
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: 'https://atc.example.com',
    allowedHosts: [],
    trustForwardedFrom: [],
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openAuthDatabase: openTestAuthDatabase,
    printRequest: () => {},
    printSecurity: () => {},
    serviceTokens: {
      resource: 'https://other.example.com/mcp',
      clients: [{ name: 'reader', scopes: ['read'], tokens: [`atcs_${'r'.repeat(40)}`] }],
    },
  });

  expect(started).rejects.toThrow(
    "the service token file is not for the resource 'https://atc.example.com/mcp'",
  );
});

test('it leaves a token written as the resource out of the start error', async () => {
  const temporaryDirectory = setupTempDir('atc-mcp-service-tokens-');
  const token = `atcs_${'r'.repeat(40)}`;

  const started = startMCPHTTPServer({
    caller: buildStubFleetCaller(),
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: 'https://atc.example.com',
    allowedHosts: [],
    trustForwardedFrom: [],
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openAuthDatabase: openTestAuthDatabase,
    printRequest: () => {},
    printSecurity: () => {},
    serviceTokens: {
      resource: token,
      clients: [{ name: 'reader', scopes: ['read'], tokens: [token] }],
    },
  });

  const error = await started.then(
    () => null,
    (error_: unknown) => error_,
  );

  expect(String(error)).not.toContain(token);
});

test('it issues OAuth client IDs that no service client ID can equal', async () => {
  const ctx = await setupTest(null);

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  expect(created.clientID).toMatch(/^[A-Za-z0-9]{32}$/u);
  expect(isServiceClientID(created.clientID)).toBeFalse();
  expect(isServiceClientID(buildServiceClientID('ci-bot'))).toBeTrue();
});
