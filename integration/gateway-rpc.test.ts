import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openTestAuthAdmin } from '@atc/app/test-utils/open-test-auth-admin';
import { startTestDaemon } from '@atc/app/test-utils/start-test-daemon';
import { readJSONRecord } from '@atc/core/test-utils/read-json-record';
import { createFleetRouter } from '@atc/fleet-api';
import { buildBindingPayloadHash, createGatewayStore, openGatewayCaller } from '@atc/gateway';
import { buildMockKeyBindingClaim } from '@atc/gateway/test-utils/build-mock-key-binding-claim';
import { buildMockRegistryDaemon } from '@atc/gateway/test-utils/build-mock-registry-daemon';
import { openTestBindingDatabase } from '@atc/gateway/test-utils/open-test-binding-database';
import { mintServiceSecret, startMCPHTTPServer } from '@atc/mcp';
import { buildStubAuthenticator } from '@atc/mcp/test-utils/build-stub-authenticator';
import { readEventStream } from '@atc/mcp/test-utils/read-event-stream';
import { runMCPTokenGrant } from '@atc/mcp/test-utils/run-mcp-token-grant';
import { runPasskeyEnrollment } from '@atc/mcp/test-utils/run-passkey-enrollment';
import { buildMockAgentAdapter } from '@atc/plugin-api/test-utils/build-mock-agent-adapter';
import { createDaemonClient } from '@atc/protocol/client';
import { connectGateway } from '@atcx/client/gateway';
import { FLEET_CONTRACT, GRANT_SCOPES } from '@atcx/contract';
import { CONTRACT_MAJOR, CONTRACT_VERSION } from '@atcx/contract/light';
import { registerTestCleanup } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';
import { openMCPAuthDatabase } from '../packages/app/src/mcp/open-mcp-auth-database';

async function setupTest() {
  const temporaryDirectory = createTempDir('atc-gateway-rpc-');
  const authDBPath = join(temporaryDirectory.path, 'mcp-auth.db');

  const auth = await openTestAuthAdmin(authDBPath);

  const redirectURI = 'https://claude.ai/api/mcp/auth_callback';

  const claude = await auth.admin.clients.add('Claude', [redirectURI]);

  const daemonToken = randomBytes(16).toString('hex');

  writeFileSync(join(temporaryDirectory.path, 'cloud-token'), `${daemonToken}\n`);

  const cloud = await startTestDaemon({
    prefix: 'atc-gateway-rpc-cloud-',
    options: () => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
      principals: new Map([
        [claude.clientID, ['local']],
        ['service:ci', ['local']],
        ['service:reader', ['local']],
      ]),
      listen: {
        host: '127.0.0.1',
        port: 0,
        tokenFile: join(temporaryDirectory.path, 'cloud-token'),
      },
    }),
  });

  const prober = createDaemonClient(cloud.socketPath);

  registerTestCleanup(() => {
    prober.stop();
  });

  const hello = await prober.sendHello(cloud.build);

  const bindings = openTestBindingDatabase(join(temporaryDirectory.path, 'gateway.db'));
  const store = createGatewayStore(bindings);

  registerTestCleanup(() => {
    store.stop();
  });

  const cloudDaemon = buildMockRegistryDaemon({
    name: 'cloud',
    address: { host: '127.0.0.1', port: Number(cloud.daemon.listenPort) },
    daemonID: String(hello['daemonID']),
    token: daemonToken,
  });

  const gateway = openGatewayCaller({
    registry: { daemons: new Map([['cloud', cloudDaemon]]), defaultDaemon: 'cloud' },
    build: 'atc-gateway/test',
    openChannel: (address) => createDaemonClient({ hostname: address.host, port: address.port }),
    bindings,
    onWarning: () => {},
    fanOutTimeoutMs: 1000,
  });

  registerTestCleanup(() => gateway.stop());

  // oxlint-disable-next-line zgeoff/function-verb -- Bun.serve names its handler fetch
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port ?? 0;

  await probe.stop(true);

  const staticToken = `atcs_${randomBytes(24).toString('hex')}`;
  const readerToken = `atcs_${randomBytes(24).toString('hex')}`;
  const secret = mintServiceSecret();
  const requests: string[] = [];
  const security: string[] = [];
  const calls: Record<string, unknown>[] = [];

  const recordingCaller = {
    ...gateway.caller,
    sendRequest: (...args: Parameters<typeof gateway.caller.sendRequest>) => {
      const [method, params] = args;

      if (method === 'session.spawn' && params !== undefined) {
        calls.push({ ...params });
      }

      return gateway.caller.sendRequest(...args);
    },
  };

  const server = await startMCPHTTPServer({
    caller: recordingCaller,
    router: createFleetRouter({ caller: recordingCaller, contract: FLEET_CONTRACT }),
    build: 'atc-gateway/test',
    rpc: true,
    rpcKeepAliveMs: 40,
    host: '127.0.0.1',
    port,
    publicURL: null,
    allowedHosts: [],
    trustForwardedFrom: [],
    dbPath: authDBPath,
    openAuthDatabase: openMCPAuthDatabase,
    printRequest: (line) => {
      requests.push(line);
    },
    printSecurity: (line) => {
      security.push(line);
    },
    serviceTokens: {
      resource: `http://127.0.0.1:${port}/mcp`,
      clients: [
        {
          name: 'ci',
          scopes: GRANT_SCOPES,
          tokens: [staticToken],
          secretDigests: [secret.digest],
        },
        { name: 'reader', scopes: ['read'], tokens: [readerToken] },
      ],
    },
  });

  registerTestCleanup(() => server.stop());

  const authenticator = buildStubAuthenticator();

  const enrollmentToken = await auth.admin.passkeys.createEnrollmentToken();

  await runPasskeyEnrollment(server, enrollmentToken, authenticator);

  return {
    url: server.url,
    origin: server.origin,
    directory: temporaryDirectory.path,
    authenticator,
    claudeID: claude.clientID,
    redirectURI,
    staticToken,
    readerToken,
    secret: secret.secret,
    requests,
    security,
    calls,
    store,
    cloudID: String(hello['daemonID']),
    call: (procedure: string, input: unknown, headers: Record<string, string>) =>
      fetch(`${server.url}/rpc/${procedure}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-atc-major': CONTRACT_VERSION.split('.')[0] ?? '',
          ...headers,
        },
        body: JSON.stringify({ json: input }),
      }),
    server,
  };
}

test('it answers daemons.list with the gateway build and contract and each daemon features', async () => {
  const ctx = await setupTest();

  const response = await ctx.call(
    'daemons/list',
    {},
    { authorization: `Bearer ${ctx.staticToken}` },
  );

  const body = await readJSONRecord(response);

  expect(body['json']).toStrictEqual({
    build: 'atc-gateway/test',
    contract: CONTRACT_VERSION,
    defaultDaemon: 'cloud',
    daemons: [
      {
        name: 'cloud',
        state: 'up',
        build: expect.toBeString(),
        daemonID: ctx.cloudID,
        features: expect.toBeArray(),
      },
    ],
  });
});

test('it accepts a client_credentials access token as the service principal', async () => {
  const ctx = await setupTest();

  const issued = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`service:ci:${ctx.secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });

  const tokens = await readJSONRecord(issued);

  const spawned = await ctx.call(
    'session/spawn',
    { cwd: ctx.directory, idempotencyKey: 'cc-spawn' },
    { authorization: `Bearer ${String(tokens['access_token'])}` },
  );

  const body = await readJSONRecord(spawned);

  expect([spawned.status, body]).toStrictEqual([
    200,
    { json: { session: expect.objectContaining({ id: expect.toStartWith('cloud.') }) } },
  ]);
});

test('it accepts an OAuth access token as its client', async () => {
  const ctx = await setupTest();

  const granted = await runMCPTokenGrant(
    { url: ctx.url, origin: ctx.origin, authenticator: ctx.authenticator },
    {
      clientID: ctx.claudeID,
      redirectURI: ctx.redirectURI,
      scope: 'read',
      ticked: ['read'],
    },
  );

  const response = await ctx.call(
    'dirs/list',
    {},
    { authorization: `Bearer ${granted.accessToken}` },
  );

  expect(response.status).toBe(200);
});

test('it runs a static service token with the scopes of the token file and as its principal', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.call(
    'session/spawn',
    { cwd: ctx.directory, idempotencyKey: 'ci-spawn' },
    { authorization: `Bearer ${ctx.readerToken}` },
  );

  const body = await readJSONRecord(spawned);

  expect(body['json']).toMatchObject({
    code: 'insufficient_scope',
    data: { required: ['spawn'] },
  });
});

test('it answers 401 and records a bearer event for a token in the query string only', async () => {
  const ctx = await setupTest();

  const response = await fetch(`${ctx.url}/rpc/dirs/list?access_token=${ctx.staticToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atc-major': '7' },
    body: JSON.stringify({ json: {} }),
  });

  const logged = [...ctx.requests, ...ctx.security].join('\n');

  expect([
    response.status,
    logged.includes(ctx.staticToken),
    logged.includes('access_token'),
  ]).toStrictEqual([401, false, false]);

  expect(ctx.security.join('\n')).toContain('"route":"/rpc/dirs/list"');
});

test('it drops an effectRef the key binding restored from its cache', async () => {
  const ctx = await setupTest();

  const bearer = { authorization: `Bearer ${ctx.staticToken}` };

  await ctx.call('session/spawn', { cwd: ctx.directory, idempotencyKey: 'seed' }, bearer);

  const [seed] = ctx.calls;
  const replayed = { ...seed, idempotencyKey: 'lost-spawn' };

  ctx.store.claimBinding(
    buildMockKeyBindingClaim({
      principal: 'service:ci',
      operation: 'session.spawn',
      key: 'lost-spawn',
      daemon: 'cloud',
      daemonID: ctx.cloudID,
      retentionMs: 86_400_000,
      payloadHash: buildBindingPayloadHash(replayed),
    }),
    Date.now(),
  );

  ctx.store.claimFirstSend('service:ci', 'session.spawn', 'lost-spawn', Date.now());

  ctx.store.updateOutcome('service:ci', 'session.spawn', 'lost-spawn', {
    outcome: 'uncertain',
    now: Date.now(),
    effectRef: 's-lost',
  });

  const retried = await ctx.call(
    'session/spawn',
    { cwd: ctx.directory, idempotencyKey: 'lost-spawn' },
    bearer,
  );

  const body = await readJSONRecord(retried);

  expect(body['json']).toStrictEqual({
    defined: true,
    code: 'outcome_unknown',
    status: 500,
    message: expect.toBeString(),
  });
});

test('it resumes a stream from the cursor of the last event it saw, with no event lost or repeated', async () => {
  const ctx = await setupTest();

  const atc = connectGateway({ url: ctx.url, token: ctx.staticToken });

  const spawned = await atc.session.spawn({ cwd: ctx.directory, idempotencyKey: 'stream-spawn' });
  const head = await atc.events.read({});

  await atc.session.message({ session: spawned.session.id, text: 'one', idempotencyKey: 'm1' });
  await atc.session.message({ session: spawned.session.id, text: 'two', idempotencyKey: 'm2' });

  const first = await atc.events.stream({ cursor: head.cursor });

  const cursors: string[] = [];

  for await (const item of first) {
    if (item.kind === 'event') {
      cursors.push(item.event.cursor);
    }

    if (cursors.length === 2) {
      break;
    }
  }

  const [saved] = cursors;

  const resumed = await atc.events.stream({ cursor: saved });

  const afterSaved: string[] = [];

  for await (const item of resumed) {
    if (item.kind === 'event') {
      afterSaved.push(item.event.cursor);
    }

    if (afterSaved.length === 1) {
      break;
    }
  }

  expect(afterSaved).toStrictEqual(cursors.slice(1));
});

test('it never refuses the ninth stream of a client that drops and opens a stream ten times in a row', async () => {
  const ctx = await setupTest();

  const atc = connectGateway({ url: ctx.url, token: ctx.staticToken });

  const spawned = await atc.session.spawn({ cwd: ctx.directory, idempotencyKey: 'drop-spawn' });

  const results: string[] = [];

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const head = await atc.events.read({});

    await atc.session.message({
      session: spawned.session.id,
      text: `message ${attempt}`,
      idempotencyKey: `drop-m${attempt}`,
    });

    const stream = await atc.events.stream({ cursor: head.cursor });

    for await (const item of stream) {
      results.push(item.kind);
      break;
    }
  }

  expect(results).toStrictEqual(Array.from({ length: 10 }, () => 'event'));
});

test('it refuses a foreign Host over HTTP before it reads the bearer', async () => {
  const ctx = await setupTest();

  const response = await ctx.call(
    'dirs/list',
    {},
    { authorization: `Bearer ${ctx.staticToken}`, host: 'evil.example' },
  );

  expect([
    response.status,
    ctx.security
      .filter((line) => line.includes('"route":"/rpc'))
      .map((line) => JSON.parse(line.slice('atc security '.length)).kind),
  ]).toStrictEqual([403, ['bad_host']]);
});

test('it refuses a foreign Origin over HTTP before it reads the bearer', async () => {
  const ctx = await setupTest();

  const response = await ctx.call(
    'dirs/list',
    {},
    { authorization: `Bearer ${ctx.staticToken}`, origin: 'https://evil.example' },
  );

  expect([
    response.status,
    ctx.security
      .filter((line) => line.includes('"route":"/rpc'))
      .map((line) => JSON.parse(line.slice('atc security '.length)).kind),
  ]).toStrictEqual([403, ['bad_origin']]);
});

test('it answers a missing bearer with the challenge /mcp sends and records a bearer event', async () => {
  const ctx = await setupTest();
  const response = await ctx.call('dirs/list', {}, {});

  expect([
    response.status,
    response.headers.get('www-authenticate'),
    ctx.security
      .filter((line) => line.includes('"route":"/rpc'))
      .map((line) => JSON.parse(line.slice('atc security '.length))),
  ]).toStrictEqual([
    401,
    `Bearer resource_metadata="${ctx.origin}/.well-known/oauth-protected-resource/mcp"`,
    [
      expect.objectContaining({
        kind: 'bearer',
        outcome: 'rejected',
        reason: 'missing',
        route: '/rpc/dirs/list',
      }),
    ],
  ]);
});

test.each([
  { title: 'is missing', major: null },
  { title: 'is another major', major: String(CONTRACT_MAJOR + 1) },
])(
  'it answers protocol_mismatch with the gateway major over HTTP when x-atc-major $title',
  async (row) => {
    const ctx = await setupTest();

    const response = await fetch(`${ctx.url}/rpc/dirs/list`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.staticToken}`,
        ...(row.major === null ? {} : { 'x-atc-major': row.major }),
      },
      body: JSON.stringify({ json: {} }),
    });

    const body = await readJSONRecord(response);

    expect(body['json']).toStrictEqual({
      defined: true,
      code: 'protocol_mismatch',
      status: 500,
      message: expect.toBeString(),
      data: { gatewayMajor: CONTRACT_MAJOR },
    });
  },
);

test('it answers an error with its code, message and only the data a program may read', async () => {
  const ctx = await setupTest();

  const response = await ctx.call(
    'session/spawn',
    { cwd: ctx.directory, idempotencyKey: 'trim-spawn' },
    { authorization: `Bearer ${ctx.readerToken}` },
  );

  const body = await readJSONRecord(response);

  expect(body['json']).toStrictEqual({
    defined: true,
    code: 'insufficient_scope',
    status: 500,
    message: expect.toBeString(),
    data: { required: ['spawn'] },
  });
});

test('it logs the request line with the route and the procedure and never the query string', async () => {
  const ctx = await setupTest();

  await fetch(`${ctx.url}/rpc/dirs/list/extra-segment?access_token=${ctx.staticToken}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ctx.staticToken}`,
      'x-atc-major': CONTRACT_VERSION.split('.')[0] ?? '',
    },
    body: JSON.stringify({ json: {} }),
  });

  await ctx.call('dirs/list', {}, { authorization: `Bearer ${ctx.staticToken}` });

  expect(ctx.requests.filter((line) => line.includes('/rpc'))).toStrictEqual([
    expect.stringMatching(/^POST \/rpc 404 \d+ms$/u),
    expect.stringMatching(/^POST \/rpc\/dirs\/list 200 \d+ms$/u),
  ]);
});

test('it sends keep-alive comments on a stream opened over HTTP', async () => {
  const ctx = await setupTest();

  const atc = connectGateway({ url: ctx.url, token: ctx.staticToken });

  const head = await atc.events.read({});

  const controller = new AbortController();

  registerTestCleanup(() => {
    controller.abort();
  });

  const response = await fetch(`${ctx.url}/rpc/events/stream`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ctx.staticToken}`,
      'x-atc-major': CONTRACT_VERSION.split('.')[0] ?? '',
    },
    body: JSON.stringify({ json: { cursor: head.cursor } }),
    signal: controller.signal,
  });

  const read = await readEventStream(response, { comments: 2 });

  expect([response.status, read.comments]).toStrictEqual([200, 2]);
});
