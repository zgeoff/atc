import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { openTestAuthAdmin } from '@atc/app/test-utils/open-test-auth-admin';
import { buildStubClock } from '@atc/core/test-utils/build-stub-clock';
import { getRecord } from '@atc/core/test-utils/get-record';
import { getRecords } from '@atc/core/test-utils/get-records';
import { getString } from '@atc/core/test-utils/get-string';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { startTestDaemon } from '@atc/daemon/test-utils/start-test-daemon';
import { createTransportCaller, startMCPHTTPServer } from '@atc/mcp';
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
import { z } from 'zod';
import { openMCPAuthDatabase } from '../packages/app/src/mcp/open-mcp-auth-database';

async function setupTest() {
  const planHookEvents = mock<AgentAdapter['planHookEvents']>();

  const daemon = await startTestDaemon({
    prefix: 'atc-mcp-http-events-',
    options: () => ({ adapter: buildMockAgentAdapter({ planHookEvents }) }),
  });

  const caller = createTransportCaller(daemon.socketPath, daemon.build, (path) =>
    createDaemonClient(path),
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

    const store = await openTestAuthAdmin(dbPath);

    return { server, store };
  };

  return { daemon, planHookEvents, clock, directory: daemon.directory, startServer };
}

test('it lets a subscriber that lost a notification find its event by reading the trail from its saved cursor', async () => {
  const ctx = await setupTest();

  ctx.planHookEvents.mockReturnValue({ events: [{ kind: 'turn-done' }] });

  const receiver = buildStubWebhookReceiver();
  const authenticator = buildStubAuthenticator();

  const started = await ctx.startServer(receiver.send);

  const enrollment = { token: await started.store.admin.passkeys.createEnrollmentToken() };

  await runPasskeyEnrollment(started.server, enrollment.token, authenticator);

  const created = await started.store.admin.clients.add('ChatGPT', [
    'https://chatgpt.com/connector_platform_oauth_redirect',
  ]);

  const grant = await runMCPTokenGrant(
    { url: started.server.url, origin: started.server.origin, authenticator },
    {
      clientID: created.clientID,
      redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
      scope: 'read',
      ticked: ['read'],
    },
  );

  const subscribed = await sendModernMCPRequest(
    started.server.url,
    grant.accessToken,
    'events/subscribe',
    {
      name: 'session.turn_done',
      arguments: {},
      delivery: {
        mode: 'webhook',
        url: 'https://connectors.example.com/hooks/atc',
        secret: `whsec_${Buffer.alloc(32, 8).toString('base64')}`,
      },
      cursor: null,
    },
  );

  const savedCursor = getString(getRecord(subscribed.body, 'result'), 'cursor');

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const sessionID = getString(getRecord(spawned, 'session'), 'id');

  await ctx.daemon.sendHookLines({ atcId: sessionID, event: 'Stop', payload: {} });
  await ctx.daemon.sendHookLines({ atcId: sessionID, event: 'Stop', payload: {} });

  await waitFor(() => {
    expect(receiver.received).toHaveLength(3);
  });

  const lastDelivery = receiver.received.at(-1);

  invariant(lastDelivery, 'the endpoint received no second delivery');

  const read = await sendModernMCPRequest(started.server.url, grant.accessToken, 'tools/call', {
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

  ctx.planHookEvents.mockReturnValue({ events: [{ kind: 'turn-done' }] });

  const receiver = buildStubWebhookReceiver({ answers: [{ failure: 'timeout' }] });
  const authenticator = buildStubAuthenticator();

  const started = await ctx.startServer(receiver.send);

  const enrollment = { token: await started.store.admin.passkeys.createEnrollmentToken() };

  await runPasskeyEnrollment(started.server, enrollment.token, authenticator);

  const created = await started.store.admin.clients.add('ChatGPT', [
    'https://chatgpt.com/connector_platform_oauth_redirect',
  ]);

  const grant = await runMCPTokenGrant(
    { url: started.server.url, origin: started.server.origin, authenticator },
    {
      clientID: created.clientID,
      redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
      scope: 'read',
      ticked: ['read'],
    },
  );

  await sendModernMCPRequest(started.server.url, grant.accessToken, 'events/subscribe', {
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

  const savedCursor = z.object({ cursor: z.string() }).parse(JSON.parse(first.body)).cursor;

  const read = await sendModernMCPRequest(started.server.url, grant.accessToken, 'tools/call', {
    name: 'atc_events_read',
    arguments: { cursor: savedCursor },
  });

  const structured = getRecord(getRecord(read.body, 'result'), 'structuredContent');

  expect(repeat.body).toBe(first.body);
  expect(repeat.headers['webhook-id']).toBe(first.headers['webhook-id']);
  expect(getRecords(structured, 'events')).not.toPartiallyContain({ kind: 'turn-done' });
});
