import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { openMCPAuth } from '../mcp/open-mcp-auth';
import { ReconnectingCaller } from '../mcp/reconnecting-caller';
import { startMCPHTTPServer } from '../mcp/start-mcp-http-server';
import { runMCPAuthorization } from './run-mcp-authorization';
import { setupTempDir } from './setup-temp-dir';

// The MCP HTTP server with every approval line it prints collected. An
// authorization never reaches the daemon, so the caller points at a socket
// nothing listens on and never dials it.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-run-mcp-authorization-'));
  const dbPath = join(tmp.dir, 'mcp-auth.db');
  const approvals: string[] = [];

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  stack.defer(() => caller.stop());

  const server = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: null,
    allowedHosts: [],
    dbPath,
    printApproval: (line) => {
      approvals.push(line);
    },
    printRequest: () => {},
  });

  stack.defer(() => server.stop());

  // The authorization database opened the way `atc clients` opens it, to
  // register clients through.
  const store = await openMCPAuth({ dbPath, origin: null });

  stack.defer(() => store.close());

  const owned = stack.move();

  return {
    url: server.url,
    origin: server.origin,
    approvals,
    store,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it returns at the redirect URI with an authorization code its verifier exchanges for tokens', async () => {
  await using ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'dots', redirectURIs: ['https://dots.example/cb'] },
  });

  const authorized = await runMCPAuthorization(ctx, {
    clientID: created.clientID,
    redirectURI: 'https://dots.example/cb',
    scope: 'read',
    ticked: ['read'],
  });

  const exchanged = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: 'https://dots.example/cb',
      client_id: created.clientID,
      code_verifier: authorized.verifier,
    }),
  });

  expect(authorized.callback.href).toStartWith('https://dots.example/cb?code=');
  expect(authorized.callback.searchParams.get('code')).toBe(authorized.code);
  expect(authorized.verifier).toStartWith('test-verifier-');
  expect(exchanged.status).toBe(200);
});

test('it throws when the authorization stops short of the login page', async () => {
  await using ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'dots', redirectURIs: ['https://dots.example/cb'] },
  });

  const authorizing = runMCPAuthorization(ctx, {
    clientID: created.clientID,
    redirectURI: 'https://dots.example/cb',
    scope: 'read write',
    ticked: ['read'],
  });

  expect(authorizing).rejects.toThrowWithMessage(
    Error,
    /^authorization did not reach the login page: https:\/\/dots\.example\/cb\?error=invalid_scope&/,
  );
});

test('it throws when the server printed no approval code', async () => {
  await using ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'dots', redirectURIs: ['https://dots.example/cb'] },
  });

  const authorizing = runMCPAuthorization(
    { url: ctx.url, origin: ctx.origin, approvals: [] },
    {
      clientID: created.clientID,
      redirectURI: 'https://dots.example/cb',
      scope: 'read',
      ticked: ['read'],
    },
  );

  expect(authorizing).rejects.toThrowWithMessage(Error, 'the server printed no approval code');
});

test('it throws when the approval code does not reach the consent page', async () => {
  await using ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'dots', redirectURIs: ['https://dots.example/cb'] },
  });

  const authorizing = runMCPAuthorization(
    {
      url: ctx.url,
      origin: ctx.origin,
      approvals: ['Approve dots (returns to dots.example) with code 0000-0000'],
    },
    {
      clientID: created.clientID,
      redirectURI: 'https://dots.example/cb',
      scope: 'read',
      ticked: ['read'],
    },
  );

  expect(authorizing).rejects.toThrowWithMessage(
    Error,
    `the approval code did not reach the consent page: ${ctx.url}/`,
  );
});

test('it throws when the consent redirect holds no authorization code', async () => {
  await using ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'dots', redirectURIs: ['https://dots.example/cb'] },
  });

  const authorizing = runMCPAuthorization(ctx, {
    clientID: created.clientID,
    redirectURI: 'https://dots.example/cb',
    scope: 'read',
    ticked: [],
  });

  expect(authorizing).rejects.toThrowWithMessage(
    Error,
    /^the consent redirect holds no authorization code: https:\/\/dots\.example\/cb\?error=access_denied&/,
  );
});

test('it throws when the consent page answers without a redirect', async () => {
  await using ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'dots', redirectURIs: ['https://dots.example/cb'] },
  });

  const authorizing = runMCPAuthorization(ctx, {
    clientID: created.clientID,
    redirectURI: 'https://dots.example/cb',
    scope: 'read',
    ticked: ['message'],
  });

  expect(authorizing).rejects.toThrowWithMessage(Error, /^consent did not redirect: 400 /);
});
