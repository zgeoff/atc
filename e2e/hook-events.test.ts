import { expect, test } from 'bun:test';
import { decodeMessage } from '@atc/protocol/wire';
import { buildMockAgentAdapter, spawnNamedSession, subscribeToSocketLines } from '@atc/test-utils';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// Events-socket tests: snapshot-then-stream and read-only behavior. The
// overflow disconnect lives in start-events-server.test.ts, and protocol
// behavior in daemon.test.ts.

function setupTest() {
  return startTestDaemon({
    prefix: 'atc-events-',
    options: () => ({ adapter: buildMockAgentAdapter() }),
  });
}

test('it replays the fleet as SessionAdded lines on connect', async () => {
  const ctx = await setupTest();

  await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'one', ctx.dir);
  await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'two', ctx.dir);

  const subscriber = await subscribeToSocketLines(ctx.eventsSocketPath);
  const initial = await subscriber.waitForLine(2);

  expect(initial.map((line) => decodeMessage(line))).toMatchObject([
    {
      kind: 'event',
      message: {
        v: 6,
        ev: 'SessionAdded',
        session: { name: 'one', cwd: ctx.dir, agent: 'claude', alive: true },
      },
    },
    {
      kind: 'event',
      message: {
        v: 6,
        ev: 'SessionAdded',
        session: { name: 'two', cwd: ctx.dir, agent: 'claude', alive: true },
      },
    },
  ]);
});

test('it streams a live event after the replay', async () => {
  const ctx = await setupTest();
  const sessionID = await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'one', ctx.dir);
  const subscriber = await subscribeToSocketLines(ctx.eventsSocketPath);

  await subscriber.waitForLine(1);
  await ctx.client.sendRequest('session.update', { session: sessionID, name: 'renamed-one' });

  const streamed = await subscriber.waitForLine(2);

  expect(streamed.map((line) => decodeMessage(line))).toPartiallyContain({
    kind: 'event',
    message: { v: 6, ev: 'SessionRenamed', s: sessionID, name: 'renamed-one', namedBy: 'user' },
  });
});

test('it ignores subscriber input and keeps streaming', async () => {
  const ctx = await setupTest();
  const subscriber = await subscribeToSocketLines(ctx.eventsSocketPath);

  subscriber.write('{"m":"session.kill"}\nnot even json\n');

  await spawnNamedSession((m, p) => ctx.client.sendRequest(m, p), 'after-garbage', ctx.dir);

  const streamed = await subscriber.waitForLine(1);

  expect(streamed.map((line) => decodeMessage(line))).toMatchObject([
    { kind: 'event', message: { v: 6, ev: 'SessionAdded', session: { name: 'after-garbage' } } },
  ]);
});
