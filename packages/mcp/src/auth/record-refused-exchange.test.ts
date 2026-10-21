import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubClock, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { createSecurityEventLog } from './create-security-event-log';
import { openMCPAuth } from './open-mcp-auth';
import { recordRefusedExchange } from './record-refused-exchange';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-refused-exchange-');
  const lines: string[] = [];
  const clock = buildStubClock(Date.now());

  const store = await openMCPAuth({
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openDatabase: openTestAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  const security = createSecurityEventLog({
    print: (line) => {
      lines.push(line);
    },
    clock,
  });

  return { store, security, lines, clock };
}

test.each([
  ['invalid_request', 'invalid_request'],
  ['invalid_client', 'invalid_client'],
  ['invalid_grant', 'invalid_grant'],
  ['unauthorized_client', 'unauthorized_client'],
  ['unsupported_grant_type', 'unsupported_grant_type'],
  ['invalid_scope', 'invalid_scope'],
  ['invalid_target', 'invalid_target'],
  ['server_error', 'other'],
])('it records the error code %p as the reason %p', async (code, reason) => {
  const ctx = await setupTest();

  await recordRefusedExchange(ctx, {
    contentType: null,
    body: '',
    response: Response.json({ error: code }, { status: 400 }),
    path: '/oauth2/token',
    requester: { socketAddress: '127.0.0.1', connectingIP: null, userAgent: null },
  });

  expect(
    JSON.parse(`[${ctx.lines.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toStrictEqual([
    {
      version: 1,
      ts: new Date(ctx.clock.now()).toISOString(),
      kind: 'token_exchange',
      outcome: 'rejected',
      reason,
      route: '/oauth2/token',
      peer: { address: '127.0.0.1', provenance: 'socket' },
    },
  ]);
});

test('it records an error code outside the fixed list as other and keeps the code out of the event', async () => {
  const ctx = await setupTest();

  await recordRefusedExchange(ctx, {
    contentType: null,
    body: '',
    response: Response.json(
      { error: 'canary-secret', error_description: 'canary-secret' },
      { status: 400 },
    ),
    path: '/oauth2/token',
    requester: { socketAddress: '127.0.0.1', connectingIP: null, userAgent: null },
  });

  expect(
    JSON.parse(`[${ctx.lines.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toStrictEqual([
    {
      version: 1,
      ts: new Date(ctx.clock.now()).toISOString(),
      kind: 'token_exchange',
      outcome: 'rejected',
      reason: 'other',
      route: '/oauth2/token',
      peer: { address: '127.0.0.1', provenance: 'socket' },
    },
  ]);

  expect(ctx.lines).toSatisfyAll((line: string) => !line.includes('canary-secret'));
});
