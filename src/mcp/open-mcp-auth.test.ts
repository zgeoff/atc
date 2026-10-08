import { expect, test } from 'bun:test';
import { chmodSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startStubTelemetryCollector } from '../test-utils/start-stub-telemetry-collector';
import { openMCPAuth } from './open-mcp-auth';

// A temp directory for the store.
function setupTest() {
  const tmp = setupTempDir('atc-mcp-auth-');

  return { dir: tmp.dir, dbPath: join(tmp.dir, 'mcp-auth.db') };
}

test('it sends no telemetry when the environment turns it on', async () => {
  const ctx = setupTest();
  const collector = startStubTelemetryCollector();

  // better-auth never sends telemetry under NODE_ENV=test, so the store
  // opens in a production-mode process of its own. A request the store
  // starts keeps that process alive until the collector answers it, so the
  // process exits only after any request has arrived.
  const opened = Bun.spawn(
    [
      process.execPath,
      '-e',
      `const { openMCPAuth } = await import(${JSON.stringify(join(import.meta.dir, 'open-mcp-auth.ts'))});
const store = await openMCPAuth({ dbPath: ${JSON.stringify(ctx.dbPath)}, origin: null });
await store.auth.$context;
await store.close();`,
    ],
    {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: ctx.dir,
        NODE_ENV: 'production',
        BETTER_AUTH_TELEMETRY: '1',
        BETTER_AUTH_TELEMETRY_ENDPOINT: collector.url,
      },
      stderr: 'pipe',
    },
  );

  registerTestCleanup(() => {
    opened.kill();

    return opened.exited;
  });

  const exitCode = await opened.exited;

  expect(exitCode).toBe(0);
  expect(collector.received).toStrictEqual([]);
});

test('it refuses a resource an earlier public URL served', async () => {
  const ctx = setupTest();

  const before = await openMCPAuth({ dbPath: ctx.dbPath, origin: 'https://old.example' });

  const closeBefore = registerTestCleanup(() => before.close());

  await before.auth.$context;

  const created = await before.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  await closeBefore();

  const after = await openMCPAuth({ dbPath: ctx.dbPath, origin: 'https://new.example' });

  registerTestCleanup(() => after.close());

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

test('it creates the database and its write-ahead log readable by their owner only', async () => {
  const ctx = setupTest();

  const store = await openMCPAuth({ dbPath: ctx.dbPath, origin: null });

  registerTestCleanup(() => store.close());

  expect(statSync(ctx.dbPath).mode & 0o777).toBe(0o600);
  expect(statSync(`${ctx.dbPath}-wal`).mode & 0o777).toBe(0o600);
});

test('it makes an existing database readable by its owner only', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.dbPath, '', { mode: 0o644 });
  chmodSync(ctx.dbPath, 0o644);

  const store = await openMCPAuth({ dbPath: ctx.dbPath, origin: null });

  registerTestCleanup(() => store.close());

  expect(statSync(ctx.dbPath).mode & 0o777).toBe(0o600);
});
