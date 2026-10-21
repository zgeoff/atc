import { expect, test } from 'bun:test';
import { openDaemonClient } from '@atc/protocol/client';
import {
  buildMockAgentAdapter,
  registerTestCleanup,
  subscribeToSocketLines,
  waitFor,
} from '@atc/test-utils';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// Each test makes every connection to the daemon itself, so the harness opens
// no main client.
function setupTest() {
  return startTestDaemon({
    mainClient: false,
    prefix: 'atc-daemon-',

    // Every spawn needs a Claude adapter; this one runs a sleep.
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
  });
});

test('it rejects a protocol version mismatch naming both builds and closes the connection', async () => {
  const ctx = await setupTest();
  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  const refused = client.sendRequest('daemon.hello', { client: 'atc/newer-build', protocol: 9 });

  expect(refused).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message:
      'atc/newer-build speaks protocol v9, daemon atc/test-build speaks v8; restart the daemon so both run the same build',
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
