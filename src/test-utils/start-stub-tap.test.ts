import { expect, test } from 'bun:test';
import { buildMockAgentAdapter } from './build-mock-agent-adapter';
import { spawnNamedSession } from './spawn-named-session';
import { startStubTap } from './start-stub-tap';
import { startTestDaemon } from './start-test-daemon';
import { waitFor } from './wait-for';

// A daemon whose agent takes messages, one session on it, and a second
// client to make that session's tap.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  stack.use(daemon);

  const sessionID = await spawnNamedSession(
    (m, p) => daemon.client.sendRequest(m, p),
    'one',
    daemon.dir,
  );

  const tapClient = await daemon.openClient();

  const owned = stack.move();

  return { daemon, sessionID, tapClient, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it takes every pending message in the order the daemon accepted them', async () => {
  await using ctx = await setupTest();

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
    expect(tap.messages.map((event) => event['message'])).toStrictEqual([
      first['message'],
      second['message'],
    ]);
  });
});

test('it acks each message it takes', async () => {
  await using ctx = await setupTest();

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
  await using ctx = await setupTest();

  const tap = await startStubTap(ctx.tapClient, ctx.sessionID);
  const replacement = await ctx.daemon.openClient();

  await replacement.sendRequest('session.tap', { session: ctx.sessionID });

  await waitFor(() => {
    expect(tap.closed).toStrictEqual([
      { v: 4, ev: 'InboxClosed', s: ctx.sessionID, reason: 'replaced' },
    ]);
  });
});
