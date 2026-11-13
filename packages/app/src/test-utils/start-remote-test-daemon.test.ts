import { expect, test } from 'bun:test';
import { getRecord, waitFor } from '@atc/test-utils';
import { startRemoteTestDaemon } from './start-remote-test-daemon';

test('it accepts the principal laptop with the token of 32 letters a over TCP', async () => {
  const remote = await startRemoteTestDaemon();
  const client = await remote.openTCPClient();

  const hello = await client.sendHello('atc/test', {
    token: 'a'.repeat(32),
    principal: 'laptop',
  });

  expect(hello['features']).toBeArray();
});

test('it refuses a token other than the one it holds', async () => {
  const remote = await startRemoteTestDaemon();
  const client = await remote.openTCPClient();

  expect(
    client.sendHello('atc/test', { token: 'b'.repeat(32), principal: 'laptop' }),
  ).rejects.toThrow();
});

test('it echoes a line typed into a session as GOT-REMOTE', async () => {
  const remote = await startRemoteTestDaemon();

  const spawned = await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await remote.client.sendRequest('session.input', { session: id, data: 'ping\r' });

  await waitFor(async () => {
    const screen = await remote.client.sendRequest('session.screen', { session: id });

    expect(String(screen['text'])).toInclude('GOT-REMOTE:ping');
  });
});
