import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import type { AgentAdapter } from '../agents/agent-adapter';
import { DaemonClient } from '../client/daemon-client';
import { startDaemon } from './daemon';

async function setupTest() {
  const tmp = setupTempDir('atc-grants-');
  const sockPath = join(tmp.dir, 'daemon.sock');

  const adapter: AgentAdapter = {
    id: 'claude',
    headlessRunner: null,
    screenDetector: null,
    takesMessages: false,
    planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
    normalizeHook: () => ({ kind: 'heartbeat' }),
    loadName: () => Promise.resolve(null),
    canResume: () => true,
    buildResumeCommand: () => null,
  };

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter,
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
  });

  const client = await DaemonClient.open(sockPath);

  await client.sendHello('atc/test-build');

  return {
    client,
    async [Symbol.asyncDispose]() {
      client.stop();

      await daemon.stop();

      tmp[Symbol.dispose]();
    },
  };
}

test('it creates a grant that lasts an hour', async () => {
  await using ctx = await setupTest();

  const created = await ctx.client.sendRequest('grant.create', {
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read', 'message'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
  });

  expect(created).toStrictEqual({ grant: expect.stringMatching(/^g-/), expiresIn: 3600 });
});

test('it verifies an access token as its grant with the scopes granted', async () => {
  await using ctx = await setupTest();

  const created = await ctx.client.sendRequest('grant.create', {
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read', 'message'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
  });

  const verified = await ctx.client.sendRequest('grant.verify', {
    accessHash: 'a1',
    resource: 'https://atc.example/mcp',
  });

  expect(verified).toStrictEqual({
    grant: created['grant'],
    clientName: 'dots',
    scopes: ['read', 'message'],
  });
});

test('it refreshes a grant for the client it was issued to', async () => {
  await using ctx = await setupTest();

  const created = await ctx.client.sendRequest('grant.create', {
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read', 'message'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
  });

  const refreshed = await ctx.client.sendRequest('grant.refresh', {
    refreshHash: 'r1',
    accessHash: 'a2',
    nextRefreshHash: 'r2',
    clientID: 'c1',
    resource: 'https://atc.example/mcp',
  });

  expect(refreshed).toStrictEqual({
    grant: created['grant'],
    scopes: ['read', 'message'],
    expiresIn: 3600,
  });
});

test('it stops verifying an access token once its grant is revoked', async () => {
  await using ctx = await setupTest();

  const created = await ctx.client.sendRequest('grant.create', {
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read', 'message'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
  });

  const revoked = await ctx.client.sendRequest('grant.revoke', { grant: created['grant'] });

  expect(revoked).toStrictEqual({});

  expect(
    ctx.client.sendRequest('grant.verify', {
      accessHash: 'a1',
      resource: 'https://atc.example/mcp',
    }),
  ).rejects.toMatchObject({ code: 'unauthorized' });
});

test('it refuses an unknown access token with unauthorized', async () => {
  await using ctx = await setupTest();

  expect(
    ctx.client.sendRequest('grant.verify', {
      accessHash: 'nope',
      resource: 'https://atc.example/mcp',
    }),
  ).rejects.toMatchObject({ code: 'unauthorized' });
});

test('it refuses a reused refresh token with unauthorized and drops the grant', async () => {
  await using ctx = await setupTest();

  await ctx.client.sendRequest('grant.create', {
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
  });

  await ctx.client.sendRequest('grant.refresh', {
    refreshHash: 'r1',
    accessHash: 'a2',
    nextRefreshHash: 'r2',
    clientID: 'c1',
    resource: 'https://atc.example/mcp',
  });

  await ctx.client.sendRequest('grant.verify', {
    accessHash: 'a2',
    resource: 'https://atc.example/mcp',
  });

  const reuse = ctx.client.sendRequest('grant.refresh', {
    refreshHash: 'r1',
    accessHash: 'a3',
    nextRefreshHash: 'r3',
    clientID: 'c1',
    resource: 'https://atc.example/mcp',
  });

  expect(reuse).rejects.toMatchObject({ code: 'unauthorized' });

  await reuse.catch(() => null);

  const listed = await ctx.client.sendRequest('grant.list');

  expect(listed).toStrictEqual({ grants: [] });
});

test('it lists a live grant without any token material', async () => {
  await using ctx = await setupTest();

  const created = await ctx.client.sendRequest('grant.create', {
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
  });

  const listed = await ctx.client.sendRequest('grant.list');

  expect(listed).toStrictEqual({
    grants: [
      {
        id: created['grant'],
        clientID: 'c1',
        clientName: 'dots',
        scopes: ['read'],
        resource: 'https://atc.example/mcp',
        createdAt: expect.toBeNumber(),
        lastUsedAt: null,
      },
    ],
  });
});

test('it refuses to revoke an unknown grant with bad_args', async () => {
  await using ctx = await setupTest();

  expect(ctx.client.sendRequest('grant.revoke', { grant: 'g-missing' })).rejects.toMatchObject({
    code: 'bad_args',
  });
});

test('it refuses a grant with a scope outside the four with bad_args', async () => {
  await using ctx = await setupTest();

  expect(
    ctx.client.sendRequest('grant.create', {
      clientID: 'c1',
      clientName: 'dots',
      scopes: ['admin'],
      resource: 'https://atc.example/mcp',
      accessHash: 'a1',
      refreshHash: 'r1',
    }),
  ).rejects.toMatchObject({ code: 'bad_args' });
});

test('it registers a client and finds it by the id it minted', async () => {
  await using ctx = await setupTest();

  const registered = await ctx.client.sendRequest('grant.registerClient', {
    name: 'dots',
    redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
  });

  const found = await ctx.client.sendRequest('grant.findClient', {
    clientID: registered['clientID'],
  });

  expect(found).toStrictEqual({
    client: {
      clientID: registered['clientID'],
      name: 'dots',
      redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    },
  });
});

test('it finds no client for an id it never minted', async () => {
  await using ctx = await setupTest();

  const found = await ctx.client.sendRequest('grant.findClient', { clientID: 'c-missing' });

  expect(found).toStrictEqual({ client: null });
});

test('it registers clients until 100 are waiting for a grant', async () => {
  await using ctx = await setupTest();

  const registered = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      ctx.client.sendRequest('grant.registerClient', {
        name: `client ${index}`,
        redirectURIs: ['https://chatgpt.com/cb'],
      }),
    ),
  );

  expect(registered).toSatisfyAll(
    (answer: Readonly<Record<string, unknown>>) => typeof answer['clientID'] === 'string',
  );
});

test('it refuses a registration with at_capacity once 100 clients are waiting for a grant', async () => {
  await using ctx = await setupTest();

  await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      ctx.client.sendRequest('grant.registerClient', {
        name: `client ${index}`,
        redirectURIs: ['https://chatgpt.com/cb'],
      }),
    ),
  );

  expect(
    ctx.client.sendRequest('grant.registerClient', {
      name: 'one too many',
      redirectURIs: ['https://chatgpt.com/cb'],
    }),
  ).rejects.toMatchObject({ code: 'at_capacity' });
});

test('it admits exactly 100 of 150 registrations sent at once', async () => {
  await using ctx = await setupTest();

  const outcomes = await Promise.allSettled(
    Array.from({ length: 150 }, (_, index) =>
      ctx.client.sendRequest('grant.registerClient', {
        name: `client ${index}`,
        redirectURIs: ['https://chatgpt.com/cb'],
      }),
    ),
  );

  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(100);

  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toMatchObject(
    Array.from({ length: 50 }, () => ({ status: 'rejected', reason: { code: 'at_capacity' } })),
  );
});

test('it refuses a registration with a name over 200 characters with bad_args', async () => {
  await using ctx = await setupTest();

  expect(
    ctx.client.sendRequest('grant.registerClient', {
      name: 'x'.repeat(201),
      redirectURIs: ['https://chatgpt.com/cb'],
    }),
  ).rejects.toMatchObject({ code: 'bad_args' });
});
