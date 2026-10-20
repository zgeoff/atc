import { expect, test } from 'bun:test';
import { startTestDaemon } from '../../app/src/test-utils/start-test-daemon';
import { buildMockAgentAdapter } from './build-mock-agent-adapter';
import { getString } from './get-string';
import { spawnNamedSession } from './spawn-named-session';
import { startStubTap } from './start-stub-tap';
import { waitFor } from './wait-for';

// A daemon whose agent takes messages, one session on it, and a second
// client to make that session's tap.
async function setupTest() {
  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  const sessionID = await spawnNamedSession(
    (method, params) => daemon.client.sendRequest(method, params),
    'one',
    daemon.directory,
  );

  const tapClient = await daemon.openClient();

  return { daemon, sessionID, tapClient };
}

test('it takes every pending message in the order the daemon accepted them', async () => {
  const ctx = await setupTest();

  const first = await ctx.daemon.client.sendRequest('session.message', {
    session: ctx.sessionID,
    text: 'one',
  });

  const second = await ctx.daemon.client.sendRequest('session.message', {
    session: ctx.sessionID,
    text: 'two',
  });

  const tap = await startStubTap(ctx.tapClient, ctx.sessionID);

  await waitFor(() => {
    expect(tap.messages.map((event) => event.message)).toStrictEqual([
      getString(first, 'message'),
      getString(second, 'message'),
    ]);
  });
});

test('it acks each message it takes', async () => {
  const ctx = await setupTest();

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: ctx.sessionID,
    text: 'one',
  });

  await startStubTap(ctx.tapClient, ctx.sessionID);

  await waitFor(async () => {
    const got = await ctx.daemon.client.sendRequest('message.get', { message: sent['message'] });

    expect(got['status']).toBe('delivered');
  });
});

test('it records the end of its subscription', async () => {
  const ctx = await setupTest();
  const tap = await startStubTap(ctx.tapClient, ctx.sessionID);
  const replacement = await ctx.daemon.openClient();

  await replacement.sendRequest('session.tap', { session: ctx.sessionID });

  await waitFor(() => {
    expect(tap.closed).toStrictEqual([{ ev: 'InboxClosed', s: ctx.sessionID, reason: 'replaced' }]);
  });
});

test('it takes the notice of a message the session sent when it asks for notices', async () => {
  const ctx = await setupTest();

  const sender = await spawnNamedSession(
    (method, params) => ctx.daemon.client.sendRequest(method, params),
    'sender',
    ctx.daemon.directory,
  );

  const inside = await ctx.daemon.openClient({ session: sender });
  const tap = await startStubTap(ctx.tapClient, sender, { notices: true });

  const sent = await inside.sendRequest('session.message', {
    session: ctx.sessionID,
    text: 'archive the old logs',
  });

  await ctx.daemon.client.sendRequest('session.kill', { session: ctx.sessionID });
  await ctx.daemon.client.sendRequest('session.kill', { session: ctx.sessionID });

  await waitFor(() => {
    expect<unknown[]>(tap.notices).toStrictEqual([
      {
        ev: 'InboxNotice',
        s: sender,
        message: getString(sent, 'message'),
        from: ctx.sessionID,
        status: 'unanswered',
        reason: 'session_ended',
        at: expect.any(Number) as unknown,
      },
    ]);
  });
});

test('it acks each notice it takes', async () => {
  const ctx = await setupTest();

  const sender = await spawnNamedSession(
    (method, params) => ctx.daemon.client.sendRequest(method, params),
    'sender',
    ctx.daemon.directory,
  );

  const inside = await ctx.daemon.openClient({ session: sender });

  await startStubTap(ctx.tapClient, sender, { notices: true });

  const sent = await inside.sendRequest('session.message', {
    session: ctx.sessionID,
    text: 'archive the old logs',
  });

  await ctx.daemon.client.sendRequest('session.kill', { session: ctx.sessionID });
  await ctx.daemon.client.sendRequest('session.kill', { session: ctx.sessionID });

  // The daemon records the notice as delivered only once its ack arrives.
  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('events.read', { session: sender });

    expect(read['events']).toPartiallyContain({
      kind: 'notice-delivered',
      message: getString(sent, 'message'),
    });
  });
});

test('it takes no notice when it does not ask for notices', async () => {
  const ctx = await setupTest();

  const sender = await spawnNamedSession(
    (method, params) => ctx.daemon.client.sendRequest(method, params),
    'sender',
    ctx.daemon.directory,
  );

  const inside = await ctx.daemon.openClient({ session: sender });
  const tap = await startStubTap(ctx.tapClient, sender);

  const sent = await inside.sendRequest('session.message', {
    session: ctx.sessionID,
    text: 'archive the old logs',
  });

  await ctx.daemon.client.sendRequest('session.kill', { session: ctx.sessionID });
  await ctx.daemon.client.sendRequest('session.kill', { session: ctx.sessionID });

  await waitFor(async () => {
    const got = await ctx.daemon.client.sendRequest('message.get', { message: sent['message'] });

    expect(got['status']).toBe('unanswered');
  });

  expect(tap.notices).toStrictEqual([]);
});
