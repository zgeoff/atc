import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { startTestDaemon } from '@atc/daemon/testing';
import {
  createEnrollmentToken,
  createTransportCaller,
  openMCPAuth,
  startMCPHTTPServer,
} from '@atc/mcp';
import type { WebhookSender } from '@atc/mcp';
import { buildStubWebhookReceiver } from '@atc/mcp/testing';
import { openDaemonClient } from '@atc/protocol/client';
import {
  buildMockAgentAdapter,
  buildStubAuthenticator,
  buildStubClock,
  getRecord,
  getRecords,
  getString,
  registerTestCleanup,
  runMCPTokenGrant,
  runPasskeyEnrollment,
  sendModernMCPRequest,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { z } from 'zod';
import { openMCPAuthDatabase } from '../packages/app/src/open-mcp-auth-database';

// The subscriber's endpoint is the receiver each test passes, because a test
// cannot reach an endpoint across the internet.
async function setupTest() {
  const daemon = await startTestDaemon({
    prefix: 'atc-mcp-http-events-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        planHookEvents: () => ({ events: [{ kind: 'turn-done' }] }),
      }),
    }),
  });

  const caller = createTransportCaller(daemon.socketPath, daemon.build, (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const clock = buildStubClock(Date.now());
  const dbPath = join(daemon.directory, 'mcp-auth.db');

  const startServer = async (sendWebhook: WebhookSender) => {
    const server = await startMCPHTTPServer({
      caller,
      build: 'atc/test-build',
      host: '127.0.0.1',
      port: 0,
      publicURL: null,
      allowedHosts: [],
      trustForwardedFrom: [],
      dbPath,
      openAuthDatabase: openMCPAuthDatabase,
      printRequest: () => {},
      printSecurity: () => {},
      clock,
      sendWebhook,
    });

    registerTestCleanup(() => server.stop());

    const store = await openMCPAuth({ dbPath, openDatabase: openMCPAuthDatabase, origin: null });

    registerTestCleanup(() => store.close());

    const authenticator = buildStubAuthenticator();

    const enrollment = await createEnrollmentToken(store.db, Date.now());

    await runPasskeyEnrollment(server, enrollment.token, authenticator);

    const created = await store.auth.api.createFixedClient({
      body: {
        name: 'ChatGPT',
        redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      },
    });

    const grant = await runMCPTokenGrant(
      { url: server.url, origin: server.origin, authenticator },
      {
        clientID: created.clientID,
        redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
        scope: 'read',
        ticked: ['read'],
      },
    );

    return { url: server.url, token: grant.accessToken };
  };

  return { daemon, clock, directory: daemon.directory, startServer };
}

test('it lets a subscriber that lost a notification find its event by reading the trail from its saved cursor', async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver();

  const server = await ctx.startServer(receiver.send);

  const subscribed = await sendModernMCPRequest(server.url, server.token, 'events/subscribe', {
    name: 'session.turn_done',
    arguments: {},
    delivery: {
      mode: 'webhook',
      url: 'https://connectors.example.com/hooks/atc',
      secret: `whsec_${Buffer.alloc(32, 8).toString('base64')}`,
    },
    cursor: null,
  });

  const savedCursor = getString(getRecord(subscribed.body, 'result'), 'cursor');

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const sessionID = getString(getRecord(spawned, 'session'), 'id');

  await ctx.daemon.sendHookLines({ atcId: sessionID, event: 'Stop', payload: {} });
  await ctx.daemon.sendHookLines({ atcId: sessionID, event: 'Stop', payload: {} });

  // The verification challenge and both deliveries; the subscriber never saw
  // the first delivery, and acts on the second alone.
  await waitFor(() => {
    expect(receiver.received).toHaveLength(3);
  });

  const lastDelivery = receiver.received.at(-1);

  invariant(lastDelivery, 'the endpoint received no second delivery');

  const read = await sendModernMCPRequest(server.url, server.token, 'tools/call', {
    name: 'atc_events_read',
    arguments: { cursor: savedCursor },
  });

  const structured = getRecord(getRecord(read.body, 'result'), 'structuredContent');
  const events = getRecords(structured, 'events');

  expect(events).toIncludeAllPartialMembers([
    { session: sessionID, kind: 'turn-done' },
    {
      session: sessionID,
      kind: 'turn-done',
      cursor: z.object({ cursor: z.string() }).parse(JSON.parse(lastDelivery.body)).cursor,
    },
  ]);

  expect(events.filter((event) => event['kind'] === 'turn-done')).toHaveLength(2);
});

test('it repeats a notification whose answer was lost with its eventId, after which the trail holds no new work', async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver({ answers: [{ failure: 'timeout' }] });

  const server = await ctx.startServer(receiver.send);

  await sendModernMCPRequest(server.url, server.token, 'events/subscribe', {
    name: 'session.turn_done',
    arguments: {},
    delivery: {
      mode: 'webhook',
      url: 'https://connectors.example.com/hooks/atc',
      secret: `whsec_${Buffer.alloc(32, 8).toString('base64')}`,
    },
    cursor: null,
  });

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  await ctx.daemon.sendHookLines({
    atcId: getString(getRecord(spawned, 'session'), 'id'),
    event: 'Stop',
    payload: {},
  });

  await waitFor(() => {
    expect(ctx.clock.collectPending()).toContain(30_000);
  });

  ctx.clock.advance(30_000);

  await waitFor(() => {
    expect(receiver.received).toHaveLength(3);
  });

  const [, first, repeat] = receiver.received;

  invariant(first && repeat, 'the endpoint received fewer than two deliveries');

  // The subscriber acted on the first copy and saved the cursor it carried.
  const savedCursor = z.object({ cursor: z.string() }).parse(JSON.parse(first.body)).cursor;

  const read = await sendModernMCPRequest(server.url, server.token, 'tools/call', {
    name: 'atc_events_read',
    arguments: { cursor: savedCursor },
  });

  const structured = getRecord(getRecord(read.body, 'result'), 'structuredContent');

  expect(repeat.body).toBe(first.body);
  expect(repeat.headers['webhook-id']).toBe(first.headers['webhook-id']);
  expect(getRecords(structured, 'events')).not.toPartiallyContain({ kind: 'turn-done' });
});
