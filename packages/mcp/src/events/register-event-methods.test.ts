import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { startTestDaemon } from '@atc/daemon/testing';
import { openDaemonClient } from '@atc/protocol/client';
import {
  buildMockAgentAdapter,
  buildStubAuthenticator,
  registerTestCleanup,
  runMCPTokenGrant,
  runPasskeyEnrollment,
  sendModernMCPRequest,
} from '@atc/test-utils';
import { createEnrollmentToken } from '../auth/create-enrollment-token';
import { openMCPAuth } from '../auth/open-mcp-auth';
import { startMCPHTTPServer } from '../http/start-mcp-http-server';
import { buildStubWebhookReceiver } from '../testing/build-stub-webhook-receiver';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { createTransportCaller } from '../tools/create-transport-caller';

// `atc mcp --http` in front of a daemon, with the owner's passkey enrolled
// and a stand-in for the subscriber's endpoint that echoes each challenge.
async function setupTest() {
  const daemon = await startTestDaemon({
    prefix: 'atc-event-methods-',
    options: () => ({ adapter: buildMockAgentAdapter() }),
  });

  const dbPath = join(daemon.directory, 'mcp-auth.db');
  const receiver = buildStubWebhookReceiver();

  const caller = createTransportCaller(daemon.socketPath, daemon.build, (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const server = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: null,
    allowedHosts: [],
    trustForwardedFrom: [],
    dbPath,
    openAuthDatabase: openTestAuthDatabase,
    printRequest: () => {},
    printSecurity: () => {},
    sendWebhook: receiver.send,
  });

  registerTestCleanup(() => server.stop());

  const store = await openMCPAuth({ dbPath, openDatabase: openTestAuthDatabase, origin: null });

  registerTestCleanup(() => store.close());

  const authenticator = buildStubAuthenticator();

  const enrollment = await createEnrollmentToken(store.db, Date.now());

  await runPasskeyEnrollment(server, enrollment.token, authenticator);

  return { url: server.url, origin: server.origin, authenticator, store, receiver };
}

test("it declares Events under the draft's extensions entry and the events key ChatGPT reads", async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: {
      name: 'ChatGPT',
      redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    },
  });

  const grant = await runMCPTokenGrant(ctx, {
    clientID: created.clientID,
    redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
    scope: 'read',
    ticked: ['read'],
  });

  const answer = await sendModernMCPRequest(ctx.url, grant.accessToken, 'server/discover');

  expect(answer.body).toMatchObject({
    result: {
      supportedVersions: ['2026-07-28'],
      capabilities: {
        tools: { listChanged: false },
        extensions: { 'io.modelcontextprotocol/events': {} },
        events: {},
      },
    },
  });
});

test('it lists each event type for webhook delivery with no arguments and a session payload', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: {
      name: 'ChatGPT',
      redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    },
  });

  const grant = await runMCPTokenGrant(ctx, {
    clientID: created.clientID,
    redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
    scope: 'read',
    ticked: ['read'],
  });

  const answer = await sendModernMCPRequest(ctx.url, grant.accessToken, 'events/list');

  const descriptor = {
    description: expect.toBeString(),
    delivery: ['webhook'],
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    payloadSchema: {
      type: 'object',
      properties: { session: { type: 'string', description: expect.toBeString() } },
      required: ['session'],
      additionalProperties: false,
    },
  };

  expect(answer.body).toMatchObject({
    result: {
      resultType: 'complete',
      events: [
        { name: 'session.needs_input', ...descriptor },
        { name: 'session.turn_done', ...descriptor },
        { name: 'session.ended', ...descriptor },
        { name: 'session.note', ...descriptor },
      ],
    },
  });
});

test('it subscribes a verified callback and answers with the grant', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: {
      name: 'ChatGPT',
      redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    },
  });

  const grant = await runMCPTokenGrant(ctx, {
    clientID: created.clientID,
    redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
    scope: 'read',
    ticked: ['read'],
  });

  const answer = await sendModernMCPRequest(ctx.url, grant.accessToken, 'events/subscribe', {
    name: 'session.needs_input',
    arguments: {},
    delivery: {
      mode: 'webhook',
      url: 'https://connectors.example.com/hooks/atc',
      secret: `whsec_${Buffer.alloc(32, 8).toString('base64')}`,
    },
    cursor: null,
  });

  expect(answer).toStrictEqual({
    status: 200,
    body: {
      jsonrpc: '2.0',
      id: 1,
      result: {
        id: expect.stringMatching(/^sub_[0-9a-f]{32}$/u),
        refreshBefore: expect.toBeString(),
        cursor: expect.toBeString(),
        truncated: false,
        resultType: 'complete',
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'atc', version: 'atc/test-build' } },
      },
    },
  });

  expect(ctx.receiver.received).toPartiallyContain({
    url: 'https://connectors.example.com/hooks/atc',
  });
});

test('it refuses a subscribe to a plain http callback with invalid params', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: {
      name: 'ChatGPT',
      redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    },
  });

  const grant = await runMCPTokenGrant(ctx, {
    clientID: created.clientID,
    redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
    scope: 'read',
    ticked: ['read'],
  });

  const answer = await sendModernMCPRequest(ctx.url, grant.accessToken, 'events/subscribe', {
    name: 'session.needs_input',
    delivery: {
      mode: 'webhook',
      url: 'http://connectors.example.com/hooks/atc',
      secret: `whsec_${Buffer.alloc(32, 8).toString('base64')}`,
    },
  });

  expect(answer.body).toMatchObject({
    error: { code: -32_602, message: 'delivery.url must be an https URL with no credentials' },
  });
});
