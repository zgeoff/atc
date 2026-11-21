import { expect, test } from 'bun:test';
import { startTestDaemon } from '@atc/app/test-utils/start-test-daemon';
import { buildMockAgentAdapter } from '@atc/plugin-api/test-utils/build-mock-agent-adapter';
import { openRawDaemonClient as openDaemonClient } from '@atc/protocol/test-utils/open-raw-daemon-client';
import { subscribeToSocketLines } from '@atc/protocol/test-utils/subscribe-to-socket-lines';
import { CONTRACT_MAJOR } from '@atcx/contract/light';
import { registerTestCleanup, waitFor } from '@zgeoff/testing';

function setupTest() {
  return startTestDaemon({
    mainClient: false,
    prefix: 'atc-daemon-',

    options: () => ({ adapter: buildMockAgentAdapter() }),
  });
}

test('it answers daemon.hello with the build and limits', async () => {
  const ctx = await setupTest();
  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  const ok = await client.sendHello('atc/test-build');

  expect(ok).toStrictEqual({
    daemon: ctx.build,
    daemonID: expect.stringMatching(/^[\da-f-]{36}$/u),
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    idempotency: { completedRetentionMs: 86_400_000 },
    lastUsedAgent: 'claude',
    peerSession: null,
    features: [
      'events.read.from-start',
      'daemon.hello.viewer',
      'session.forget.workspace',
      'session.host',
      'full-replay',
    ],
  });
});

test('it rejects a major version mismatch naming both builds and closes the connection', async () => {
  const ctx = await setupTest();
  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  const refused = client.sendRequest('daemon.hello', {
    client: 'atc/newer-build',
    major: CONTRACT_MAJOR + 1,
  });

  expect(refused).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message: `atc/newer-build is on major version ${CONTRACT_MAJOR + 1} and protocol v15, daemon atc/test-build speaks v15 on major version ${CONTRACT_MAJOR}; restart the daemon so both run the same major version`,
    data: { daemonProtocol: 15, daemonMajor: CONTRACT_MAJOR },
  });

  await Promise.allSettled([refused]);

  await waitFor(() => {
    expect(client.isClosed()).toBeTrue();
  });
});

test('it closes a connection that sends a line-protocol hello, without an answer', async () => {
  const ctx = await setupTest();
  const raw = await subscribeToSocketLines(ctx.socketPath);

  raw.write('{"v":5,"id":1,"m":"daemon.hello","p":{"client":"atc/old"}}\n');

  await raw.closed;

  expect(raw.lines).toStrictEqual([]);
});

test('it refuses any request before daemon.hello', async () => {
  const ctx = await setupTest();
  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  expect(client.sendRequest('daemon.ping')).rejects.toMatchObject({ code: 'unauthorized' });
});
