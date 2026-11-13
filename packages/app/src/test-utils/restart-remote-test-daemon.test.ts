import { expect, test } from 'bun:test';
import { spawnNamedSession, waitFor } from '@atc/test-utils';
import { restartRemoteTestDaemon } from './restart-remote-test-daemon';
import { startRemoteTestDaemon } from './start-remote-test-daemon';

test('it boots the daemon again on the same port and restores a session under its id', async () => {
  const remote = await startRemoteTestDaemon();

  const port = remote.daemon.listenPort;

  const id = await spawnNamedSession(
    (method, params) => remote.client.sendRequest(method, params),
    'far-session',
    remote.directory,
  );

  await remote.sendHookLines({
    atcId: id,
    event: 'SessionStart',
    payload: { session_id: 'agent-1' },
  });

  await waitFor(async () => {
    const listed = await remote.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  await restartRemoteTestDaemon(remote, { restoreFleet: true });

  const listed = await remote.client.sendRequest('session.list');

  expect(remote.daemon.listenPort).toBe(port);
  expect(listed['sessions']).toPartiallyContain({ id, name: 'far-session' });
});

test('it brings the restored session back live, echoing typed lines', async () => {
  const remote = await startRemoteTestDaemon();

  const id = await spawnNamedSession(
    (method, params) => remote.client.sendRequest(method, params),
    'far-session',
    remote.directory,
  );

  await remote.sendHookLines({
    atcId: id,
    event: 'SessionStart',
    payload: { session_id: 'agent-1' },
  });

  await waitFor(async () => {
    const listed = await remote.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id, agentSessionID: 'agent-1' });
  });

  await restartRemoteTestDaemon(remote, { restoreFleet: true });

  await remote.client.sendRequest('session.input', { session: id, data: 'again\r' });

  await waitFor(async () => {
    const screen = await remote.client.sendRequest('session.screen', { session: id });

    expect(String(screen['text'])).toInclude('GOT-REMOTE:again');
  });
});

test('it lists no session after a restart without a fleet restore', async () => {
  const remote = await startRemoteTestDaemon();

  await spawnNamedSession(
    (method, params) => remote.client.sendRequest(method, params),
    'far-session',
    remote.directory,
  );

  await restartRemoteTestDaemon(remote, { restoreFleet: false });

  const listed = await remote.client.sendRequest('session.list');

  expect(listed).toStrictEqual({ sessions: [] });
});

test('it rejects a restart with a fleet restore when the daemon holds no fleet', async () => {
  const remote = await startRemoteTestDaemon();

  expect(restartRemoteTestDaemon(remote, { restoreFleet: true })).rejects.toThrowWithMessage(
    Error,
    /skipped its fleet restore: empty/u,
  );
});
