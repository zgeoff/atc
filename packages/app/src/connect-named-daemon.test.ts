import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalPTYProvider } from '@atc/execution-local';
import { buildMockAgentAdapter, getRecord, setupTempDir, waitFor } from '@atc/test-utils';
import type { DaemonEvent } from '@atcx/contract';
import invariant from 'tiny-invariant';
import { connectNamedDaemon } from './connect-named-daemon';
import { buildLocalTarget } from './test-utils/build-local-target';
import { buildMockRemoteDaemon } from './test-utils/build-mock-remote-daemon';
import { startTestDaemon } from './test-utils/start-test-daemon';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-connect-named-');

  return { tokenFile: join(temporaryDirectory.path, 'box.token') };
}

test('it lists the sessions of the daemon as the principal of its config entry', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['laptop', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.directory, 'gateway-token') },
      };
    },
  });

  invariant(remote.daemon.listenPort !== null, 'the remote daemon bound no TCP port');

  await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'on-the-box',
    cols: 80,
    rows: 24,
  });

  const connection = connectNamedDaemon(
    buildMockRemoteDaemon({
      name: 'box',
      host: '127.0.0.1',
      port: remote.daemon.listenPort,
      token: { kind: 'file', path: ctx.tokenFile },
      principal: 'laptop',
    }),
    'atc/test-client',
  );

  onTestFinished(() => connection.caller.stop());

  const listed = await connection.caller.sendRequest('session.list');

  expect(listed['sessions']).toStrictEqual([expect.objectContaining({ name: 'on-the-box' })]);
});

test("it lists for a connector's tool request only the sessions the connector may read", async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        targets: [
          buildLocalTarget(),
          {
            id: 'spare',
            kind: 'local-pty',
            options: {},
            identity: 'test:spare',
            provider: createLocalPTYProvider(),
          },
        ],
        principals: new Map([
          ['laptop', ['local', 'spare']],
          ['web-panel', ['local']],
        ]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.directory, 'gateway-token') },
      };
    },
  });

  invariant(remote.daemon.listenPort !== null, 'the remote daemon bound no TCP port');

  await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'on-local',
    cols: 80,
    rows: 24,
  });

  await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'on-spare',
    target: 'spare',
    cols: 80,
    rows: 24,
  });

  const connection = connectNamedDaemon(
    buildMockRemoteDaemon({
      name: 'box',
      host: '127.0.0.1',
      port: remote.daemon.listenPort,
      token: { kind: 'file', path: ctx.tokenFile },
      principal: 'laptop',
    }),
    'atc/test-client',
  );

  onTestFinished(() => connection.caller.stop());

  const listed = await connection.caller.sendRequest('session.list', undefined, {
    id: 'web-panel',
    name: 'Web panel',
  });

  expect(listed['sessions']).toStrictEqual([expect.objectContaining({ name: 'on-local' })]);
});

test("it hides a session outside the entry principal's targets from a live-terminal viewer that reaches it", async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([
          ['laptop', ['elsewhere']],
          ['web-panel', ['local']],
        ]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.directory, 'gateway-token') },
      };
    },
  });

  invariant(remote.daemon.listenPort !== null, 'the remote daemon bound no TCP port');

  const spawned = await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'local-only',
    cols: 80,
    rows: 24,
  });

  const connection = connectNamedDaemon(
    buildMockRemoteDaemon({
      name: 'box',
      host: '127.0.0.1',
      port: remote.daemon.listenPort,
      token: { kind: 'file', path: ctx.tokenFile },
      principal: 'laptop',
    }),
    'atc/test-client',
  );

  const channel = await connection.openWatchChannel('web-panel');

  onTestFinished(() => {
    channel.stop();
  });

  const sessionID = String(getRecord(spawned, 'session')['id']);

  expect(channel.procedures.session.get({ session: sessionID })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test('it refuses a live-terminal viewer a watch of a session that only the entry principal may read', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        targets: [
          buildLocalTarget(),
          {
            id: 'spare',
            kind: 'local-pty',
            options: {},
            identity: 'test:spare',
            provider: createLocalPTYProvider(),
          },
        ],
        principals: new Map([
          ['laptop', ['local', 'spare']],
          ['web-panel', ['local']],
        ]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.directory, 'gateway-token') },
      };
    },
  });

  invariant(remote.daemon.listenPort !== null, 'the remote daemon bound no TCP port');

  const spawned = await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'on-spare',
    target: 'spare',
    cols: 80,
    rows: 24,
  });

  const connection = connectNamedDaemon(
    buildMockRemoteDaemon({
      name: 'box',
      host: '127.0.0.1',
      port: remote.daemon.listenPort,
      token: { kind: 'file', path: ctx.tokenFile },
      principal: 'laptop',
    }),
    'atc/test-client',
  );

  const channel = await connection.openWatchChannel('web-panel');

  onTestFinished(() => {
    channel.stop();
  });

  const sessionID = String(getRecord(spawned, 'session')['id']);

  expect(channel.procedures.session.watch({ session: sessionID })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test('it lets a live-terminal viewer watch a session that the entry and the viewer may both read', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([
          ['laptop', ['local']],
          ['web-panel', ['local']],
        ]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.directory, 'gateway-token') },
      };
    },
  });

  invariant(remote.daemon.listenPort !== null, 'the remote daemon bound no TCP port');

  const spawned = await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'on-local',
    cols: 80,
    rows: 24,
  });

  const connection = connectNamedDaemon(
    buildMockRemoteDaemon({
      name: 'box',
      host: '127.0.0.1',
      port: remote.daemon.listenPort,
      token: { kind: 'file', path: ctx.tokenFile },
      principal: 'laptop',
    }),
    'atc/test-client',
  );

  const channel = await connection.openWatchChannel('web-panel');

  onTestFinished(() => {
    channel.stop();
  });

  const sessionID = String(getRecord(spawned, 'session')['id']);

  const watched = await channel.procedures.session.watch({ session: sessionID });

  expect(watched).toMatchObject({ cols: 80, rows: 24 });
});

test('it sends a live-terminal viewer no event of a session that only the entry principal may read', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        targets: [
          buildLocalTarget(),
          {
            id: 'spare',
            kind: 'local-pty',
            options: {},
            identity: 'test:spare',
            provider: createLocalPTYProvider(),
          },
        ],
        principals: new Map([
          ['laptop', ['local', 'spare']],
          ['web-panel', ['local']],
        ]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.directory, 'gateway-token') },
      };
    },
  });

  invariant(remote.daemon.listenPort !== null, 'the remote daemon bound no TCP port');

  const connection = connectNamedDaemon(
    buildMockRemoteDaemon({
      name: 'box',
      host: '127.0.0.1',
      port: remote.daemon.listenPort,
      token: { kind: 'file', path: ctx.tokenFile },
      principal: 'laptop',
    }),
    'atc/test-client',
  );

  const channel = await connection.openWatchChannel('web-panel');

  onTestFinished(() => {
    channel.stop();
  });

  const events: DaemonEvent[] = [];

  channel.onEvent = (event) => {
    events.push(event);
  };

  const spare = await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'on-spare',
    target: 'spare',
    cols: 80,
    rows: 24,
  });

  const marker = await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'on-local',
    cols: 80,
    rows: 24,
  });

  const markerID = String(getRecord(marker, 'session')['id']);

  await waitFor(() => {
    expect(events).toPartiallyContain({
      ev: 'SessionAdded',
      session: expect.objectContaining({ id: markerID }),
    });
  });

  expect(JSON.stringify(events)).not.toInclude(String(getRecord(spare, 'session')['id']));
});

test('it removes a watched session from a live-terminal viewer once a child joins it on a target the viewer may not use', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        targets: [
          buildLocalTarget(),
          {
            id: 'spare',
            kind: 'local-pty',
            options: {},
            identity: 'test:spare',
            provider: createLocalPTYProvider(),
          },
        ],
        principals: new Map([
          ['laptop', ['local', 'spare']],
          ['web-panel', ['local']],
        ]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.directory, 'gateway-token') },
      };
    },
  });

  invariant(remote.daemon.listenPort !== null, 'the remote daemon bound no TCP port');

  const parent = await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'watched',
    cols: 80,
    rows: 24,
  });

  const parentID = String(getRecord(parent, 'session')['id']);

  const connection = connectNamedDaemon(
    buildMockRemoteDaemon({
      name: 'box',
      host: '127.0.0.1',
      port: remote.daemon.listenPort,
      token: { kind: 'file', path: ctx.tokenFile },
      principal: 'laptop',
    }),
    'atc/test-client',
  );

  const channel = await connection.openWatchChannel('web-panel');

  onTestFinished(() => {
    channel.stop();
  });

  const events: DaemonEvent[] = [];

  channel.onEvent = (event) => {
    events.push(event);
  };

  await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'child-on-spare',
    target: 'spare',
    parent: parentID,
    cols: 80,
    rows: 24,
  });

  await waitFor(() => {
    expect(events).toPartiallyContain({ ev: 'SessionRemoved', sessionID: parentID });
  });
});
