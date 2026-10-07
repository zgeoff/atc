import { expect, test } from 'bun:test';
import { buildMockAgentAdapter } from './build-mock-agent-adapter';
import { spawnNamedSession } from './spawn-named-session';
import { startStubTap } from './start-stub-tap';
import { startTestDaemon } from './start-test-daemon';
import { waitFor } from './wait-for';

test('it takes every pending message in the order the daemon accepted them', async () => {
  await using daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  const id = await spawnNamedSession((m, p) => daemon.client.sendRequest(m, p), 'one', daemon.dir);
  const first = await daemon.client.sendRequest('session.message', { session: id, text: 'one' });
  const second = await daemon.client.sendRequest('session.message', { session: id, text: 'two' });
  const tapClient = await daemon.openClient();
  const tap = await startStubTap(tapClient, id);

  await waitFor(() => {
    expect(tap.messages.map((event) => event['message'])).toStrictEqual([
      first['message'],
      second['message'],
    ]);
  });
});

test('it acks each message it takes', async () => {
  await using daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  const id = await spawnNamedSession((m, p) => daemon.client.sendRequest(m, p), 'one', daemon.dir);
  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'one' });
  const tapClient = await daemon.openClient();

  await startStubTap(tapClient, id);

  await waitFor(async () => {
    const got = await daemon.client.sendRequest('message.get', { message: sent['message'] });

    expect(got['status']).toBe('delivered');
  });
});

test('it records the end of its subscription', async () => {
  await using daemon = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  const id = await spawnNamedSession((m, p) => daemon.client.sendRequest(m, p), 'one', daemon.dir);
  const tapClient = await daemon.openClient();
  const tap = await startStubTap(tapClient, id);
  const replacement = await daemon.openClient();

  await replacement.sendRequest('session.tap', { session: id });

  await waitFor(() => {
    expect(tap.closed).toStrictEqual([{ v: 4, ev: 'InboxClosed', s: id, reason: 'replaced' }]);
  });
});
