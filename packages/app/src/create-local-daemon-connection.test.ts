import { expect, onTestFinished, test } from 'bun:test';
import { buildMockAgentAdapter, getRecord } from '@atc/test-utils';
import { createLocalDaemonConnection } from './create-local-daemon-connection';
import { startTestDaemon } from './test-utils/start-test-daemon';

test('it opens a live-terminal channel that reads only what its viewer may read', async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter(),
      principals: new Map([['web-panel', ['elsewhere']]]),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    agent: 'claude',
    name: 'on-local',
    cols: 80,
    rows: 24,
  });

  const sessionID = String(getRecord(spawned, 'session')['id']);
  const connection = createLocalDaemonConnection(daemon.socketPath, 'atc/test-client');

  onTestFinished(() => connection.caller.stop());

  const channel = await connection.openWatchChannel('web-panel');

  onTestFinished(() => {
    channel.stop();
  });

  expect(channel.procedures.session.get({ session: sessionID })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test("it opens the owner's live-terminal channel when the viewer gives no principal", async () => {
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter(),
      principals: new Map([['web-panel', ['elsewhere']]]),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    agent: 'claude',
    name: 'on-local',
    cols: 80,
    rows: 24,
  });

  const sessionID = String(getRecord(spawned, 'session')['id']);
  const connection = createLocalDaemonConnection(daemon.socketPath, 'atc/test-client');

  onTestFinished(() => connection.caller.stop());

  const channel = await connection.openWatchChannel(null);

  onTestFinished(() => {
    channel.stop();
  });

  expect(channel.procedures.session.get({ session: sessionID })).resolves.toMatchObject({
    session: { name: 'on-local' },
  });
});
