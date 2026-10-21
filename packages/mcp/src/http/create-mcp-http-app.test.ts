import { expect, mock, test } from 'bun:test';
import type { SecurityEvent } from '../auth/types';
import { createMCPHTTPApp } from './create-mcp-http-app';

// The app before the authorization server opens: the Host check and the
// probes run without a context, so no database is wired.
function setupTest() {
  const record = mock<(event: SecurityEvent) => void>();
  const onMCPRequest = mock<(request: Request) => Promise<void>>();

  const app = createMCPHTTPApp({
    hosts: new Set(['127.0.0.1:4100']),
    origins: new Set(['http://127.0.0.1:4100']),
    probes: true,
    readContext: () => null,
    readRequester: () => ({ socketAddress: '127.0.0.1', connectingIP: null, userAgent: 'curl/8' }),
    onMCPRequest,
    security: { record },
  });

  return { app, record, onMCPRequest };
}

test('it refuses a token request whose Host header it does not serve and records it', async () => {
  const ctx = setupTest();

  const answered = await ctx.app.handle(
    new Request('http://127.0.0.1:4100/oauth2/token', {
      method: 'POST',
      headers: { host: 'rebound.example' },
      body: 'grant_type=authorization_code',
    }),
  );

  expect(answered.status).toBe(403);

  expect(ctx.record).toHaveBeenCalledExactlyOnceWith({
    kind: 'authorize_invalid',
    outcome: 'rejected',
    reason: 'bad_host',
    path: '/oauth2/token',
    requester: { socketAddress: '127.0.0.1', connectingIP: null, userAgent: 'curl/8' },
  });
});

test('it refuses an MCP request whose Host header it does not serve before the MCP route runs', async () => {
  const ctx = setupTest();

  const answered = await ctx.app.handle(
    new Request('http://127.0.0.1:4100/mcp', {
      method: 'POST',
      headers: { host: 'rebound.example' },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    }),
  );

  expect(answered.status).toBe(403);
  expect(ctx.onMCPRequest).not.toHaveBeenCalled();
});

test('it answers a served Host with 503 while the authorization server is not open', async () => {
  const ctx = setupTest();

  const answered = await ctx.app.handle(
    new Request('http://127.0.0.1:4100/.well-known/oauth-authorization-server', {
      headers: { host: '127.0.0.1:4100' },
    }),
  );

  expect(answered.status).toBe(503);
  expect(ctx.record).not.toHaveBeenCalled();
});

test('it answers the health probe while the authorization server is not open', async () => {
  const ctx = setupTest();

  const answered = await ctx.app.handle(
    new Request('http://127.0.0.1:4100/healthz', { headers: { host: '127.0.0.1:4100' } }),
  );

  expect(answered.status).toBe(200);
});

test('it answers the readiness probe as not ready while the authorization server is not open', async () => {
  const ctx = setupTest();

  const answered = await ctx.app.handle(
    new Request('http://127.0.0.1:4100/readyz', { headers: { host: '127.0.0.1:4100' } }),
  );

  expect(answered.status).toBe(503);
});

test('it answers a probe sent with POST with 405 and the methods it takes', async () => {
  const ctx = setupTest();

  const answered = await ctx.app.handle(
    new Request('http://127.0.0.1:4100/healthz', {
      method: 'POST',
      headers: { host: '127.0.0.1:4100' },
    }),
  );

  expect(answered.status).toBe(405);
  expect(answered.headers.get('allow')).toBe('GET, HEAD');
});
