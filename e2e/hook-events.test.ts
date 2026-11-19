import { expect, test } from 'bun:test';
import { startTestDaemon } from '@atc/app/test-utils/start-test-daemon';
import { buildMockAgentAdapter } from '@atc/plugin-api/test-utils/build-mock-agent-adapter';
import { spawnNamedSession } from '@atc/protocol/test-utils/spawn-named-session';
import { subscribeToSocketLines } from '@atc/protocol/test-utils/subscribe-to-socket-lines';
import { decodeMessage } from '@atc/protocol/wire';

function setupTest() {
  return startTestDaemon({
    prefix: 'atc-events-',
    options: () => ({ adapter: buildMockAgentAdapter() }),
  });
}

test('it replays the fleet as SessionAdded lines on connect', async () => {
  const ctx = await setupTest();

  await spawnNamedSession(
    (method, params) => ctx.client.sendRequest(method, params),
    'one',
    ctx.directory,
  );

  await spawnNamedSession(
    (method, params) => ctx.client.sendRequest(method, params),
    'two',
    ctx.directory,
  );

  const subscriber = await subscribeToSocketLines(ctx.eventsSocketPath);
  const initial = await subscriber.waitForLine(2);

  expect(initial.map((line) => decodeMessage(line))).toMatchObject([
    {
      kind: 'event',
      message: {
        version: 14,
        ev: 'SessionAdded',
        session: { name: 'one', cwd: ctx.directory, agent: 'claude', alive: true },
      },
    },
    {
      kind: 'event',
      message: {
        version: 14,
        ev: 'SessionAdded',
        session: { name: 'two', cwd: ctx.directory, agent: 'claude', alive: true },
      },
    },
  ]);
});

test('it streams a live event after the replay', async () => {
  const ctx = await setupTest();

  const sessionID = await spawnNamedSession(
    (method, params) => ctx.client.sendRequest(method, params),
    'one',
    ctx.directory,
  );

  const subscriber = await subscribeToSocketLines(ctx.eventsSocketPath);

  await subscriber.waitForLine(1);
  await ctx.client.sendRequest('session.update', { session: sessionID, name: 'renamed-one' });

  const streamed = await subscriber.waitForLine(2);

  expect(streamed.map((line) => decodeMessage(line))).toPartiallyContain({
    kind: 'event',
    message: { version: 14, ev: 'SessionRenamed', sessionID, name: 'renamed-one', namedBy: 'user' },
  });
});

test('it ignores subscriber input and keeps streaming', async () => {
  const ctx = await setupTest();
  const subscriber = await subscribeToSocketLines(ctx.eventsSocketPath);

  subscriber.write('{"m":"session.kill"}\nnot even json\n');

  await spawnNamedSession(
    (method, params) => ctx.client.sendRequest(method, params),
    'after-garbage',
    ctx.directory,
  );

  const streamed = await subscriber.waitForLine(1);

  expect(streamed.map((line) => decodeMessage(line))).toMatchObject([
    {
      kind: 'event',
      message: { version: 14, ev: 'SessionAdded', session: { name: 'after-garbage' } },
    },
  ]);
});
