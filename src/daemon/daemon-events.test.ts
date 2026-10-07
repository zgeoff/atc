import { expect, test } from 'bun:test';
import { decodeMessage } from '../protocol/protocol';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { spawnNamedSession } from '../test-utils/spawn-named-session';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { subscribeToSocketLines } from '../test-utils/subscribe-to-socket-lines';

// Events-socket tests: snapshot-then-stream and read-only behavior. The
// overflow disconnect lives in start-events-server.test.ts, and protocol
// behavior in daemon.test.ts.

/**
 * A real daemon with its events socket, whose sessions run a sleep with no
 * agent CLI behind them.
 */
function setupTest() {
  return startTestDaemon({
    prefix: 'atc-events-',
    options: () => ({ adapter: buildMockAgentAdapter() }),
  });
}

test('it replays the fleet as SessionAdded lines on connect', async () => {
  await using ctx = await setupTest();

  await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'one', ctx.dir);
  await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'two', ctx.dir);

  await using subscriber = await subscribeToSocketLines(ctx.eventsSocketPath);

  const initial = await subscriber.waitForLine(2);

  expect(initial.map((line) => decodeMessage(line))).toMatchObject([
    {
      kind: 'event',
      msg: {
        v: 4,
        ev: 'SessionAdded',
        session: { name: 'one', cwd: ctx.dir, agent: 'claude', alive: true },
      },
    },
    {
      kind: 'event',
      msg: {
        v: 4,
        ev: 'SessionAdded',
        session: { name: 'two', cwd: ctx.dir, agent: 'claude', alive: true },
      },
    },
  ]);
});

test('it streams a live event after the replay', async () => {
  await using ctx = await setupTest();

  const sessionID = await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'one', ctx.dir);

  await using subscriber = await subscribeToSocketLines(ctx.eventsSocketPath);

  await subscriber.waitForLine(1);
  await ctx.client.sendRequest('session.update', { session: sessionID, name: 'renamed-one' });

  const streamed = await subscriber.waitForLine(2);

  expect(streamed.map((line) => decodeMessage(line))).toPartiallyContain({
    kind: 'event',
    msg: { v: 4, ev: 'SessionRenamed', s: sessionID, name: 'renamed-one', namedBy: 'user' },
  });
});

test('it ignores subscriber input and keeps streaming', async () => {
  await using ctx = await setupTest();
  await using subscriber = await subscribeToSocketLines(ctx.eventsSocketPath);

  subscriber.write('{"m":"session.kill"}\nnot even json\n');

  await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'after-garbage', ctx.dir);

  const streamed = await subscriber.waitForLine(1);

  expect(streamed.map((line) => decodeMessage(line))).toMatchObject([
    { kind: 'event', msg: { v: 4, ev: 'SessionAdded', session: { name: 'after-garbage' } } },
  ]);
});
