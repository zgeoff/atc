import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { collectClients } from '../mcp/collect-clients';
import { setupMCPHTTP } from './setup-mcp-http';

test('it collects the approval line the server prints', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('dots', ['https://dots.example/cb']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  await fetch(authorize, { redirect: 'manual' });

  expect(server.approvals).toIncludeSameMembers([
    expect.stringMatching(/^Approve dots \(returns to dots\.example\) with code \w{4}-\w{4}/),
  ]);
});

test('it collects a request line for each request the server answers', async () => {
  await using server = await setupMCPHTTP();

  await fetch(`${server.url}/.well-known/oauth-protected-resource/mcp`);

  expect(server.requests).toIncludeSameMembers([
    expect.stringMatching(/^GET \/\.well-known\/oauth-protected-resource\/mcp 200 \d+ms$/),
  ]);
});

test('it keeps the authorization database where atc keeps it under the home directory', async () => {
  await using server = await setupMCPHTTP();

  expect(server.dbPath).toBe(join(server.home, '.local', 'state', 'atc', 'mcp-auth.db'));
  expect(existsSync(server.dbPath)).toBeTrue();
});

test('it adds a client the store lists under its name and redirect URIs', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('dots', ['https://dots.example/cb']);
  const clients = await collectClients(server.store.db);

  expect(clients).toStrictEqual([
    {
      clientID,
      name: 'dots',
      redirectURIs: ['https://dots.example/cb'],
      createdAt: expect.toBeString(),
    },
  ]);
});

test('it serves a request whose Host header is a host it is told to allow', async () => {
  await using server = await setupMCPHTTP({ allowedHosts: ['pc.tailnet.example'] });

  const answered = await fetch(`${server.url}/.well-known/oauth-protected-resource/mcp`, {
    headers: { host: 'pc.tailnet.example' },
  });

  expect(answered.status).toBe(200);
});

test('it refuses a request whose Host header is a host it is not told to allow', async () => {
  await using server = await setupMCPHTTP();

  const answered = await fetch(`${server.url}/.well-known/oauth-protected-resource/mcp`, {
    headers: { host: 'pc.tailnet.example' },
  });

  expect(answered.status).toBe(403);
});

test('it counts no daemon connections before the caller sends a request', async () => {
  await using server = await setupMCPHTTP();

  expect(server.countDaemonClients()).toBe(0);
});

test('it counts the daemon connections the caller holds open', async () => {
  await using server = await setupMCPHTTP();

  await server.caller.sendRequest('session.list');

  expect(server.countDaemonClients()).toBe(1);
});

test('it restarts the daemon with none of the old daemon connections', async () => {
  await using server = await setupMCPHTTP();

  await server.caller.sendRequest('session.list');
  await server.restartDaemon();

  expect(server.countDaemonClients()).toBe(0);
});

test('it serves the caller from the restarted daemon on the same socket', async () => {
  await using server = await setupMCPHTTP();

  await server.restartDaemon();

  const listed = await server.caller.sendRequest('session.list');

  expect({ listed, connections: server.countDaemonClients() }).toStrictEqual({
    listed: { sessions: [] },
    connections: 1,
  });
});

test('it stops the server and removes its home once the test finishes without a dispose', async () => {
  const setup = await setupMCPHTTP();

  onTestFinished(() => {
    expect(fetch(setup.url)).rejects.toThrow();
    expect(existsSync(setup.home)).toBeFalse();
  });
});

test('it stops the server and removes its home once disposed', async () => {
  const setup = await setupMCPHTTP();

  await setup[Symbol.asyncDispose]();

  expect(fetch(setup.url)).rejects.toThrow();
  expect(existsSync(setup.home)).toBeFalse();
});
