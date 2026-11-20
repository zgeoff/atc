import { expect, mock, test } from 'bun:test';
import { createHmac, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openTestAuthAdmin } from '@atc/app/test-utils/open-test-auth-admin';
import { startTestDaemon } from '@atc/app/test-utils/start-test-daemon';
import { buildStubClock } from '@atc/core/test-utils/build-stub-clock';
import { getRecord } from '@atc/core/test-utils/get-record';
import { getString } from '@atc/core/test-utils/get-string';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { openGatewayCaller } from '@atc/gateway';
import { buildMockRegistryDaemon } from '@atc/gateway/test-utils/build-mock-registry-daemon';
import { openTestBindingDatabase } from '@atc/gateway/test-utils/open-test-binding-database';
import { createSubscriptionStore, startMCPHTTPServer } from '@atc/mcp';
import type { WebhookSender } from '@atc/mcp';
import { buildStubAuthenticator } from '@atc/mcp/test-utils/build-stub-authenticator';
import { buildStubWebhookReceiver } from '@atc/mcp/test-utils/build-stub-webhook-receiver';
import { runMCPTokenGrant } from '@atc/mcp/test-utils/run-mcp-token-grant';
import { runPasskeyEnrollment } from '@atc/mcp/test-utils/run-passkey-enrollment';
import { sendModernMCPRequest } from '@atc/mcp/test-utils/send-modern-mcp-request';
import type { AgentAdapter } from '@atc/plugin-api';
import { buildMockAgentAdapter } from '@atc/plugin-api/test-utils/build-mock-agent-adapter';
import { createDaemonClient } from '@atc/protocol/client';
import invariant from 'tiny-invariant';
import { openMCPAuthDatabase } from '../packages/app/src/mcp/open-mcp-auth-database';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-gateway-events-');
  const dbPath = join(temporaryDirectory.path, 'mcp-auth.db');

  const auth = await openTestAuthAdmin(dbPath);

  const token = randomBytes(16).toString('hex');
  const tokenFile = join(temporaryDirectory.path, 'daemon-token');

  writeFileSync(tokenFile, `${token}\n`);

  const planHookEvents = mock<AgentAdapter['planHookEvents']>();
  const authenticator = buildStubAuthenticator();
  const clock = buildStubClock(Date.now());

  // A daemon reads the clients it lists only at boot, so the fleet starts
  // once the test has registered its client.
  const startFleet = async (clientID: string, sendWebhook: WebhookSender) => {
    const [cloud, pc] = await Promise.all([
      startTestDaemon({
        prefix: 'atc-gateway-events-cloud-',
        options: () => ({
          adapter: buildMockAgentAdapter({ planHookEvents }),
          principals: new Map([[clientID, ['local']]]),
          listen: { host: '127.0.0.1', port: 0, tokenFile },
        }),
      }),
      startTestDaemon({
        prefix: 'atc-gateway-events-pc-',
        options: () => ({
          adapter: buildMockAgentAdapter({ planHookEvents }),
          principals: new Map([[clientID, ['local']]]),
          listen: { host: '127.0.0.1', port: 0, tokenFile },
        }),
      }),
    ]);

    const cloudProber = createDaemonClient(cloud.socketPath);

    registerTestCleanup(() => {
      cloudProber.stop();
    });

    const pcProber = createDaemonClient(pc.socketPath);

    registerTestCleanup(() => {
      pcProber.stop();
    });

    const [cloudHello, pcHello] = await Promise.all([
      cloudProber.sendHello(cloud.build),
      pcProber.sendHello(pc.build),
    ]);

    const cloudID = String(cloudHello['daemonID']);
    const pcID = String(pcHello['daemonID']);

    const cloudDaemon = buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: Number(cloud.daemon.listenPort) },
      daemonID: cloudID,
      token,
    });

    const pcDaemon = buildMockRegistryDaemon({
      name: 'pc',
      address: { host: '127.0.0.1', port: Number(pc.daemon.listenPort) },
      daemonID: pcID,
      token,
    });

    const gateway = openGatewayCaller({
      registry: {
        daemons: new Map([
          ['cloud', cloudDaemon],
          ['pc', pcDaemon],
        ]),
        defaultDaemon: 'cloud',
      },
      build: 'atc-gateway/test',
      openChannel: (address) => createDaemonClient({ hostname: address.host, port: address.port }),
      bindings: openTestBindingDatabase(join(temporaryDirectory.path, 'gateway.db')),
      fanOutTimeoutMs: 1000,
      clock,
      onWarning: () => {},
    });

    registerTestCleanup(() => gateway.stop());

    const server = await startMCPHTTPServer({
      caller: gateway.caller,
      build: 'atc-gateway/test',
      host: '127.0.0.1',
      port: 0,
      publicURL: null,
      allowedHosts: [],
      trustForwardedFrom: [],
      dbPath,
      openAuthDatabase: openMCPAuthDatabase,
      printRequest: () => {},
      printSecurity: () => {},
      probes: true,
      clock,
      sendWebhook,
    });

    registerTestCleanup(() => server.stop());

    return { server, cloud, pc, cloudID, pcID };
  };

  return {
    auth,
    authenticator,
    clock,
    directory: temporaryDirectory.path,
    planHookEvents,
    startFleet,
  };
}

test("it declares Events through the gateway under the draft's extensions entry and the events key ChatGPT reads", async () => {
  const ctx = await setupTest();

  const chatGPT = await ctx.auth.admin.clients.add('ChatGPT', [
    'https://chatgpt.com/connector_platform_oauth_redirect',
  ]);

  const fleet = await ctx.startFleet(chatGPT.clientID, buildStubWebhookReceiver().send);

  const enrollment = { token: await ctx.auth.admin.passkeys.createEnrollmentToken() };

  await runPasskeyEnrollment(fleet.server, enrollment.token, ctx.authenticator);

  const grant = await runMCPTokenGrant(
    { url: fleet.server.url, origin: fleet.server.origin, authenticator: ctx.authenticator },
    {
      clientID: chatGPT.clientID,
      redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
      scope: 'read',
      ticked: ['read'],
    },
  );

  const answer = await sendModernMCPRequest(fleet.server.url, grant.accessToken, 'server/discover');

  expect(answer.body).toStrictEqual({
    jsonrpc: '2.0',
    id: 1,
    result: {
      supportedVersions: ['2026-07-28'],
      capabilities: {
        tools: { listChanged: false },
        extensions: { 'io.modelcontextprotocol/events': {} },
        events: {},
      },
      instructions: expect.toInclude('structuredContent { code, problem }'),
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'atc', version: 'atc-gateway/test' } },
    },
  });
});

test('it lists the four event types through the gateway for webhook delivery', async () => {
  const ctx = await setupTest();

  const chatGPT = await ctx.auth.admin.clients.add('ChatGPT', [
    'https://chatgpt.com/connector_platform_oauth_redirect',
  ]);

  const fleet = await ctx.startFleet(chatGPT.clientID, buildStubWebhookReceiver().send);

  const enrollment = { token: await ctx.auth.admin.passkeys.createEnrollmentToken() };

  await runPasskeyEnrollment(fleet.server, enrollment.token, ctx.authenticator);

  const grant = await runMCPTokenGrant(
    { url: fleet.server.url, origin: fleet.server.origin, authenticator: ctx.authenticator },
    {
      clientID: chatGPT.clientID,
      redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
      scope: 'read',
      ticked: ['read'],
    },
  );

  const answer = await sendModernMCPRequest(fleet.server.url, grant.accessToken, 'events/list');

  const schemas = {
    delivery: ['webhook'],
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    payloadSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'the atc session id the event belongs to' },
      },
      required: ['session'],
      additionalProperties: false,
    },
  };

  expect(answer.body).toStrictEqual({
    jsonrpc: '2.0',
    id: 1,
    result: {
      events: [
        {
          name: 'session.needs_input',
          description:
            "Fires when a session's agent waits on the owner, such as at a permission prompt. Read what it waits on with atc_events_read from your last cursor.",
          ...schemas,
        },
        {
          name: 'session.turn_done',
          description:
            "Fires when a session's agent finishes a turn. Read its events with atc_events_read from your last cursor.",
          ...schemas,
        },
        {
          name: 'session.ended',
          description:
            'Fires when a session ends. Read its events with atc_events_read from your last cursor.',
          ...schemas,
        },
        {
          name: 'session.note',
          description:
            'Fires when a session sends a note, such as a progress report or a request for a decision. Read the note with atc_events_read from your last cursor.',
          ...schemas,
        },
      ],
      resultType: 'complete',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'atc', version: 'atc-gateway/test' } },
    },
  });
});

test('it delivers a signed event from a session on the second daemon under its gateway id', async () => {
  const ctx = await setupTest();

  ctx.planHookEvents.mockReturnValue({ events: [{ kind: 'turn-done' }] });

  const chatGPT = await ctx.auth.admin.clients.add('ChatGPT', [
    'https://chatgpt.com/connector_platform_oauth_redirect',
  ]);

  const receiver = buildStubWebhookReceiver();

  const fleet = await ctx.startFleet(chatGPT.clientID, receiver.send);

  const enrollment = { token: await ctx.auth.admin.passkeys.createEnrollmentToken() };

  await runPasskeyEnrollment(fleet.server, enrollment.token, ctx.authenticator);

  const grant = await runMCPTokenGrant(
    { url: fleet.server.url, origin: fleet.server.origin, authenticator: ctx.authenticator },
    {
      clientID: chatGPT.clientID,
      redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
      scope: 'read',
      ticked: ['read'],
    },
  );

  const secret = Buffer.alloc(32, 8);

  const subscribed = await sendModernMCPRequest(
    fleet.server.url,
    grant.accessToken,
    'events/subscribe',
    {
      name: 'session.turn_done',
      arguments: {},
      delivery: {
        mode: 'webhook',
        url: 'https://connectors.example.com/hooks/atc',
        secret: `whsec_${secret.toString('base64')}`,
      },
      cursor: null,
    },
  );

  const subscriptionID = getString(getRecord(subscribed.body, 'result'), 'id');

  const spawned = await fleet.pc.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const sessionID = getString(getRecord(spawned, 'session'), 'id');

  await fleet.pc.sendHookLines({ atcId: sessionID, event: 'Stop', payload: {} });

  await waitFor(() => {
    expect(receiver.received).toHaveLength(2);
  });

  const delivery = receiver.received.at(-1);

  invariant(delivery, 'the endpoint received no delivery');

  const webhookID = delivery.headers['webhook-id'];
  const timestamp = delivery.headers['webhook-timestamp'];

  invariant(webhookID !== undefined && timestamp !== undefined, 'the delivery carries no id');

  const signature = createHmac('sha256', secret)
    .update(`${webhookID}.${timestamp}.${delivery.body}`)
    .digest('base64');

  expect(delivery.url).toBe('https://connectors.example.com/hooks/atc');
  expect(delivery.headers['webhook-signature']).toBe(`v1,${signature}`);
  expect(delivery.headers['x-mcp-subscription-id']).toBe(subscriptionID);

  expect(JSON.parse(delivery.body)).toStrictEqual({
    eventId: expect.toBeString(),
    name: 'session.turn_done',
    timestamp: expect.toBeString(),
    data: { session: `pc.${fleet.pcID.slice(0, 8)}.${sessionID}` },
    cursor: expect.toBeString(),
  });
});

test('it delivers the events of both daemons after the merged cursor a subscriber read before them', async () => {
  const ctx = await setupTest();

  ctx.planHookEvents.mockReturnValue({ events: [{ kind: 'turn-done' }] });

  const chatGPT = await ctx.auth.admin.clients.add('ChatGPT', [
    'https://chatgpt.com/connector_platform_oauth_redirect',
  ]);

  const receiver = buildStubWebhookReceiver();

  const fleet = await ctx.startFleet(chatGPT.clientID, receiver.send);

  const enrollment = { token: await ctx.auth.admin.passkeys.createEnrollmentToken() };

  await runPasskeyEnrollment(fleet.server, enrollment.token, ctx.authenticator);

  const grant = await runMCPTokenGrant(
    { url: fleet.server.url, origin: fleet.server.origin, authenticator: ctx.authenticator },
    {
      clientID: chatGPT.clientID,
      redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
      scope: 'read',
      ticked: ['read'],
    },
  );

  const read = await sendModernMCPRequest(fleet.server.url, grant.accessToken, 'tools/call', {
    name: 'atc_events_read',
    arguments: {},
  });

  const savedCursor = getString(
    getRecord(getRecord(read.body, 'result'), 'structuredContent'),
    'cursor',
  );

  const onCloud = await fleet.cloud.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const onPC = await fleet.pc.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const cloudSessionID = getString(getRecord(onCloud, 'session'), 'id');
  const pcSessionID = getString(getRecord(onPC, 'session'), 'id');

  await fleet.cloud.sendHookLines({ atcId: cloudSessionID, event: 'Stop', payload: {} });
  await fleet.pc.sendHookLines({ atcId: pcSessionID, event: 'Stop', payload: {} });

  await sendModernMCPRequest(fleet.server.url, grant.accessToken, 'events/subscribe', {
    name: 'session.turn_done',
    arguments: {},
    delivery: {
      mode: 'webhook',
      url: 'https://connectors.example.com/hooks/atc',
      secret: `whsec_${Buffer.alloc(32, 8).toString('base64')}`,
    },
    cursor: savedCursor,
  });

  await waitFor(() => {
    expect(receiver.received).toHaveLength(3);
  });

  const delivered = receiver.received.slice(1).map((request): unknown => JSON.parse(request.body));

  expect(delivered).toIncludeSameMembers([
    {
      eventId: expect.toBeString(),
      name: 'session.turn_done',
      timestamp: expect.toBeString(),
      data: { session: `cloud.${fleet.cloudID.slice(0, 8)}.${cloudSessionID}` },
      cursor: expect.toBeString(),
    },
    {
      eventId: expect.toBeString(),
      name: 'session.turn_done',
      timestamp: expect.toBeString(),
      data: { session: `pc.${fleet.pcID.slice(0, 8)}.${pcSessionID}` },
      cursor: expect.toBeString(),
    },
  ]);
});

test('it retries a refused delivery through the gateway with the same webhook-id', async () => {
  const ctx = await setupTest();

  ctx.planHookEvents.mockReturnValue({ events: [{ kind: 'turn-done' }] });

  const chatGPT = await ctx.auth.admin.clients.add('ChatGPT', [
    'https://chatgpt.com/connector_platform_oauth_redirect',
  ]);

  const receiver = buildStubWebhookReceiver({ answers: [{ status: 503 }] });

  const fleet = await ctx.startFleet(chatGPT.clientID, receiver.send);

  const enrollment = { token: await ctx.auth.admin.passkeys.createEnrollmentToken() };

  await runPasskeyEnrollment(fleet.server, enrollment.token, ctx.authenticator);

  const grant = await runMCPTokenGrant(
    { url: fleet.server.url, origin: fleet.server.origin, authenticator: ctx.authenticator },
    {
      clientID: chatGPT.clientID,
      redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
      scope: 'read',
      ticked: ['read'],
    },
  );

  await sendModernMCPRequest(fleet.server.url, grant.accessToken, 'events/subscribe', {
    name: 'session.turn_done',
    arguments: {},
    delivery: {
      mode: 'webhook',
      url: 'https://connectors.example.com/hooks/atc',
      secret: `whsec_${Buffer.alloc(32, 8).toString('base64')}`,
    },
    cursor: null,
  });

  const spawned = await fleet.pc.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  await fleet.pc.sendHookLines({
    atcId: getString(getRecord(spawned, 'session'), 'id'),
    event: 'Stop',
    payload: {},
  });

  await waitFor(() => {
    expect(receiver.received).toHaveLength(2);
  });

  // Past the refused delivery, the only gateway reads still open wait on the
  // other daemon, so their timers fall due after the first retry's backoff.
  await waitFor(() => {
    expect(ctx.clock.collectPending()).toContain(30_000);
  });

  ctx.clock.advance(30_000);

  await waitFor(() => {
    expect(receiver.received).toHaveLength(3);
  });

  const [, first, retry] = receiver.received;

  invariant(first && retry, 'the endpoint received fewer than two attempts');

  expect(retry.headers['webhook-id']).toBe(first.headers['webhook-id']);
  expect(retry.body).toBe(first.body);
});

test('it removes a subscription through the gateway whose endpoint answers 410, and delivers it nothing more', async () => {
  const ctx = await setupTest();

  ctx.planHookEvents.mockReturnValue({ events: [{ kind: 'turn-done' }] });

  const chatGPT = await ctx.auth.admin.clients.add('ChatGPT', [
    'https://chatgpt.com/connector_platform_oauth_redirect',
  ]);

  const receiver = buildStubWebhookReceiver({ answers: [{ status: 410 }] });

  const fleet = await ctx.startFleet(chatGPT.clientID, receiver.send);

  const enrollment = { token: await ctx.auth.admin.passkeys.createEnrollmentToken() };

  await runPasskeyEnrollment(fleet.server, enrollment.token, ctx.authenticator);

  const grant = await runMCPTokenGrant(
    { url: fleet.server.url, origin: fleet.server.origin, authenticator: ctx.authenticator },
    {
      clientID: chatGPT.clientID,
      redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
      scope: 'read',
      ticked: ['read'],
    },
  );

  await sendModernMCPRequest(fleet.server.url, grant.accessToken, 'events/subscribe', {
    name: 'session.turn_done',
    arguments: {},
    delivery: {
      mode: 'webhook',
      url: 'https://connectors.example.com/hooks/atc',
      secret: `whsec_${Buffer.alloc(32, 8).toString('base64')}`,
    },
    cursor: null,
  });

  const spawned = await fleet.pc.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const sessionID = getString(getRecord(spawned, 'session'), 'id');

  await fleet.pc.sendHookLines({ atcId: sessionID, event: 'Stop', payload: {} });
  await fleet.pc.sendHookLines({ atcId: sessionID, event: 'Stop', payload: {} });

  await waitFor(async () => {
    const subscriptions = await createSubscriptionStore(ctx.auth.events).readIDs();

    expect(subscriptions).toStrictEqual([]);
  });

  expect(receiver.received).toHaveLength(2);
  expect(ctx.clock.collectPending()).not.toContain(30_000);
});
