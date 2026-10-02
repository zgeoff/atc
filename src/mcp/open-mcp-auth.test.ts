import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { openMCPAuth } from './open-mcp-auth';

test('it sends no telemetry when the environment turns it on', async () => {
  using tmp = setupTempDir('atc-mcp-auth-');

  const received: string[] = [];

  const collector = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      received.push(request.url);

      return new Response(null, { status: 204 });
    },
  });

  onTestFinished(async () => {
    await collector.stop(true);
  });

  // better-auth never sends telemetry under NODE_ENV=test, so the store
  // opens in a production-mode process of its own.
  const opened = Bun.spawn(
    [
      process.execPath,
      '-e',
      `const { openMCPAuth } = await import(${JSON.stringify(join(import.meta.dir, 'open-mcp-auth.ts'))});
const store = await openMCPAuth({ dbPath: ${JSON.stringify(join(tmp.dir, 'mcp-auth.db'))}, origin: null });
await store.auth.$context;
await Bun.sleep(300);
await store.close();`,
    ],
    {
      env: {
        PATH: process.env['PATH'] ?? '',
        NODE_ENV: 'production',
        BETTER_AUTH_TELEMETRY: '1',
        BETTER_AUTH_TELEMETRY_ENDPOINT: `http://127.0.0.1:${collector.port}/`,
      },
      stderr: 'pipe',
    },
  );

  const exitCode = await opened.exited;

  expect(exitCode).toBe(0);
  expect(received).toStrictEqual([]);
});

test('it refuses a resource an earlier public URL served', async () => {
  using tmp = setupTempDir('atc-mcp-auth-');

  const dbPath = join(tmp.dir, 'mcp-auth.db');

  const before = await openMCPAuth({ dbPath, origin: 'https://old.example' });

  await before.auth.$context;

  const created = await before.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  await before.close();

  const after = await openMCPAuth({ dbPath, origin: 'https://new.example' });

  onTestFinished(async () => {
    await after.close();
  });

  const authorize = new URL('https://new.example/oauth2/authorize');

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: created.clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    resource: 'https://old.example/mcp',
  }).toString();

  const answered = await after.auth.handler(new Request(authorize.href));

  const location = new URL(answered.headers.get('location') ?? '/', 'https://new.example');

  expect(location.searchParams.get('error')).toBe('invalid_target');
});
