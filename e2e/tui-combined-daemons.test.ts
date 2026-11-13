import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StartedTestDaemon, TestDaemonConfig } from '@atc/daemon/testing';
import { openDaemonClient } from '@atc/protocol/client';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { buildDirsSource } from '@atc/source-dirs';
import { createMigratedStateDB } from '@atc/store/test-utils';
import {
  KEYS,
  buildMockAgentProfile,
  buildStubAttentionAdapter,
  spawnDaemonSession,
  spawnNamedSession,
  startStubLegacyDaemon,
  startTUIHarness,
  takeFreePort,
  waitFor,
} from '@atc/test-utils';
import { restartRemoteTestDaemon } from '../packages/app/src/test-utils/restart-remote-test-daemon';
import { startRemoteTestDaemon } from '../packages/app/src/test-utils/start-remote-test-daemon';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';
import { startTUIDaemon } from '../packages/app/src/test-utils/start-tui-daemon';

// Plain `atc` with a `daemons` entry: the local daemon runs as the client's own, and the remote
// daemon is a second test daemon on a loopback TCP port that takes the entry's principal.

async function setupTest() {
  const tui = startTUIHarness({ createStateDB: createMigratedStateDB });
  const tokenFile = join(tui.home, 'box.token');

  await startTUIDaemon(tui);

  // the local sessions report no prompt, so none of them needs you
  writeFileSync(join(tui.home, 'fake-claude-events.jsonl'), '');
  writeFileSync(tokenFile, `${'a'.repeat(32)}\n`);

  const writeEntry = (address: string) => {
    tui.writeConfig({
      daemons: { box: { address, principal: 'laptop', tokenFile } },
    });
  };

  // Attaches the TUI to a remote session whose agent session id the daemon holds, so a restart
  // restores it.
  const attachRemoteSession = async (remote: StartedTestDaemon<TestDaemonConfig>) => {
    const remoteID = await spawnNamedSession(
      (method, params) => remote.client.sendRequest(method, params),
      'far-session',
      remote.directory,
    );

    await remote.sendHookLines({
      atcId: remoteID,
      event: 'SessionStart',
      payload: { session_id: 'agent-far' },
    });

    await waitFor(async () => {
      const listed = await remote.client.sendRequest('session.list');

      expect(listed['sessions']).toPartiallyContain({ id: remoteID, agentSessionID: 'agent-far' });
    });

    writeEntry(`127.0.0.1:${remote.daemon.listenPort}`);

    tui.boot();

    await tui.waitFor('atc — control tower');

    tui.write(KEYS.ctrlSpace);

    await tui.waitFor('far-session');

    tui.write('/');

    await tui.waitFor('/ \u001B[93m█');

    tui.write('far-');

    await tui.waitFor('/ far-');

    tui.reset();
    tui.write(KEYS.enter);

    await tui.waitFor('REMOTE_UP');

    return remoteID;
  };

  const openLocalClient = async () => {
    const client = await openDaemonClient(join(tui.home, 'atc-daemon.sock'));

    await client.sendHello('atc/test');

    return client;
  };

  // A remote test daemon that lists one directory and one startable agent, so the picker can spawn on
  // it. Its sessions print REMOTE_UP and echo each typed line.
  const startPickerRemote = async () => {
    const remote = await startTestDaemon({
      options: (paths) => ({
        adapter: buildStubAttentionAdapter({
          profile: buildMockAgentProfile({ bin: 'bash' }),
          planSpawn: () => ({
            bin: 'bash',
            args: ['-c', 'echo REMOTE_UP; while read -r line; do echo "GOT-REMOTE:$line"; done'],
          }),
        }),
        principals: new Map([['laptop', ['local']]]),
        listen: {
          host: '127.0.0.1',
          port: 0,
          tokenFile,
          failureDelayMs: 0,
        },
        sources: [
          buildDirsSource({
            id: 'dirs',
            roots: [],
            readZoxideDirs: () => Promise.resolve([]),
            homeDir: paths.directory,
          }),
        ],
      }),
    });

    if (remote.daemon.listenPort === null) {
      throw new Error('the remote daemon bound no TCP port');
    }

    mkdirSync(join(remote.directory, 'alpha-box'));

    return remote;
  };

  // The picker offers a daemon once its link is up, and the link is up once its session shows in
  // the list.
  const openPickerWithRemoteUp = async (remote: StartedTestDaemon<TestDaemonConfig>) => {
    await spawnNamedSession(
      (method, params) => remote.client.sendRequest(method, params),
      'already-there',
      join(remote.directory, 'alpha-box'),
    );

    tui.write(KEYS.ctrlSpace);

    await tui.waitFor('already-there');

    tui.reset();
    tui.write('n');

    await tui.waitFor('spawn: daemon');
  };

  return {
    tui,
    tokenFile,
    writeEntry,
    attachRemoteSession,
    openLocalClient,
    startPickerRemote,
    openPickerWithRemoteUp,
  };
}

test('it lists the sessions of the local daemon and a remote daemon, each remote row with its daemon name', async () => {
  const ctx = await setupTest();
  const remote = await startRemoteTestDaemon();

  await spawnNamedSession(
    (method, params) => remote.client.sendRequest(method, params),
    'on-the-box',
    remote.directory,
  );

  ctx.writeEntry(`127.0.0.1:${remote.daemon.listenPort}`);
  ctx.tui.boot();

  await ctx.tui.waitFor('atc — control tower');

  await spawnDaemonSession(ctx.tui, 'on-the-laptop');

  ctx.tui.reset();
  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('on-the-laptop');
  await ctx.tui.waitFor('on-the-box');

  await waitFor(() => {
    const frame = ctx.tui.read().split('┌ sessions ').at(-1);

    expect(frame).toMatch(/box\s+on-the-box/u);
    expect(frame).not.toMatch(/box\s+on-the-laptop/u);
  });
});

test('it sends typed lines and the answer to a needs-you prompt to the attached remote session only', async () => {
  const ctx = await setupTest();
  const remote = await startRemoteTestDaemon();
  const local = await ctx.openLocalClient();

  const remoteID = await spawnNamedSession(
    (method, params) => remote.client.sendRequest(method, params),
    'far-session',
    remote.directory,
  );

  ctx.writeEntry(`127.0.0.1:${remote.daemon.listenPort}`);
  ctx.tui.boot();

  await ctx.tui.waitFor('atc — control tower');

  const localID = await spawnDaemonSession(ctx.tui, 'near-session');

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('far-session');

  ctx.tui.write('/');

  await ctx.tui.waitFor('/ \u001B[93m█');

  ctx.tui.write('far-');

  await ctx.tui.waitFor('/ far-');

  ctx.tui.reset();
  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('REMOTE_UP');

  ctx.tui.write(`hello-far${KEYS.enter}`);

  await ctx.tui.waitFor('GOT-REMOTE:hello-far');
  await remote.sendHookLines({ atcId: remoteID, event: 'Notification', payload: {} });

  await waitFor(async () => {
    const listed = await remote.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id: remoteID, state: 'needs_you' });
  });

  ctx.tui.write(`yes-please${KEYS.enter}`);

  await ctx.tui.waitFor('GOT-REMOTE:yes-please');

  const remoteScreen = await remote.client.sendRequest('session.screen', { session: remoteID });
  const localScreen = await local.sendRequest('session.screen', { session: localID });

  expect(String(remoteScreen['text'])).toInclude('GOT-REMOTE:yes-please');
  expect(String(localScreen['text'])).not.toInclude('hello-far');
  expect(String(localScreen['text'])).not.toInclude('yes-please');
});

test('it shows one line for a remote daemon that is down, and the local fleet stays usable', async () => {
  const ctx = await setupTest();

  ctx.writeEntry(`127.0.0.1:${takeFreePort()}`);
  ctx.tui.boot();

  await ctx.tui.waitFor('atc — control tower');

  await spawnDaemonSession(ctx.tui, 'still-here');

  ctx.tui.reset();
  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('still-here');
  await ctx.tui.waitFor('box: down');

  ctx.tui.reset();
  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('FAKE_CLAUDE_UP');
});

test('it shows one line for a remote daemon that refuses the token, and the local fleet stays usable', async () => {
  const ctx = await setupTest();
  const remote = await startRemoteTestDaemon();

  writeFileSync(ctx.tokenFile, `${'b'.repeat(32)}\n`);

  ctx.writeEntry(`127.0.0.1:${remote.daemon.listenPort}`);
  ctx.tui.boot();

  await ctx.tui.waitFor('atc — control tower');

  await spawnDaemonSession(ctx.tui, 'still-here');

  ctx.tui.reset();
  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('still-here');
  await ctx.tui.waitFor('box: unauthorized');

  ctx.tui.reset();
  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('FAKE_CLAUDE_UP');
});

test('it shows one line for a remote daemon on another protocol, and the local fleet stays usable', async () => {
  const ctx = await setupTest();

  const legacy = startStubLegacyDaemon(
    { hostname: '127.0.0.1', port: 0 },
    { protocol: PROTOCOL_V + 1 },
  );

  ctx.writeEntry(`127.0.0.1:${legacy.port}`);
  ctx.tui.boot();

  await ctx.tui.waitFor('atc — control tower');

  await spawnDaemonSession(ctx.tui, 'still-here');

  ctx.tui.reset();
  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('still-here');
  await ctx.tui.waitFor('box: mismatched');

  ctx.tui.reset();
  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('FAKE_CLAUDE_UP');
});

test('it hides the rows of a remote daemon that stops and shows its refreshed rows once it starts again', async () => {
  const ctx = await setupTest();

  const port = takeFreePort();

  const remote = await startRemoteTestDaemon(port);

  await spawnNamedSession(
    (method, params) => remote.client.sendRequest(method, params),
    'far-session',
    remote.directory,
  );

  ctx.writeEntry(`127.0.0.1:${port}`);
  ctx.tui.boot();

  await ctx.tui.waitFor('atc — control tower');

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('far-session');
  await remote.stop();

  ctx.tui.reset();

  await ctx.tui.waitFor('box: down');

  const frame = ctx.tui.read().split('┌ sessions ').at(-1);

  expect(frame).not.toInclude('far-session');

  await remote.restart();

  await spawnNamedSession(
    (method, params) => remote.client.sendRequest(method, params),
    'reborn',
    remote.directory,
  );

  await ctx.tui.waitFor('reborn');
});

test('it reattaches the attached remote session when its link drops and comes back', async () => {
  const ctx = await setupTest();
  const remote = await startRemoteTestDaemon();

  await spawnNamedSession(
    (method, params) => remote.client.sendRequest(method, params),
    'far-session',
    remote.directory,
  );

  ctx.writeEntry(`127.0.0.1:${remote.daemon.listenPort}`);
  ctx.tui.boot();

  await ctx.tui.waitFor('atc — control tower');

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('far-session');

  ctx.tui.write('/');

  await ctx.tui.waitFor('/ \u001B[93m█');

  ctx.tui.write('far-');

  await ctx.tui.waitFor('/ far-');

  ctx.tui.reset();
  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('REMOTE_UP');

  // The daemon drops the connection of a token it replaced; the client holds the new token
  // already, so its reconnect is accepted.
  writeFileSync(ctx.tokenFile, `${'b'.repeat(32)}\n`);
  writeFileSync(join(remote.directory, 'gateway-token'), `${'b'.repeat(32)}\n`);

  remote.daemon.refreshTokens();
  ctx.tui.reset();

  await ctx.tui.waitFor('REMOTE_UP');

  ctx.tui.write(`after-drop${KEYS.enter}`);

  await ctx.tui.waitFor('GOT-REMOTE:after-drop');
});

test('it reattaches the attached remote session under the same id when the remote daemon restarts with its fleet', async () => {
  const ctx = await setupTest();
  const remote = await startRemoteTestDaemon();
  const remoteID = await ctx.attachRemoteSession(remote);

  ctx.tui.reset();

  await remote.stop();
  await ctx.tui.waitFor('waiting for daemon');

  ctx.tui.reset();

  await restartRemoteTestDaemon(remote, { restoreFleet: true });

  await ctx.tui.waitFor('REMOTE_UP');

  ctx.tui.write(`after-restart${KEYS.enter}`);

  await ctx.tui.waitFor('GOT-REMOTE:after-restart');

  const screen = await remote.client.sendRequest('session.screen', { session: remoteID });

  expect(String(screen['text'])).toInclude('GOT-REMOTE:after-restart');
});

test('it returns to the list when the remote daemon restarts without the attached session', async () => {
  const ctx = await setupTest();
  const remote = await startRemoteTestDaemon();

  await ctx.attachRemoteSession(remote);

  ctx.tui.reset();

  await remote.stop();
  await ctx.tui.waitFor('waiting for daemon');

  ctx.tui.reset();

  await restartRemoteTestDaemon(remote, { restoreFleet: false });

  await ctx.tui.waitFor('no sessions — n to spawn');

  const frame = ctx.tui.read().split('┌ sessions ').at(-1);

  expect(frame).not.toInclude('far-session');
  expect(frame).not.toInclude('waiting for daemon');
});

test('it tells the user why a line typed into an attached remote session went nowhere', async () => {
  const ctx = await setupTest();
  const remote = await startRemoteTestDaemon();

  await spawnNamedSession(
    (method, params) => remote.client.sendRequest(method, params),
    'far-session',
    remote.directory,
  );

  ctx.writeEntry(`127.0.0.1:${remote.daemon.listenPort}`);
  ctx.tui.boot();

  await ctx.tui.waitFor('atc — control tower');

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('far-session');

  ctx.tui.write('/');

  await ctx.tui.waitFor('/ \u001B[93m█');

  ctx.tui.write('far-');

  await ctx.tui.waitFor('/ far-');

  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('REMOTE_UP');
  await remote.stop();
  await ctx.tui.waitFor('waiting for daemon');

  ctx.tui.reset();
  ctx.tui.write('lost-line');

  await ctx.tui.waitFor('box: down');
});

test('it shows the refusal of a connected remote daemon for a line typed into its session', async () => {
  const ctx = await setupTest();

  const stub = startStubLegacyDaemon(
    { hostname: '127.0.0.1', port: 0 },
    {
      replies: {
        'session.list': {
          sessions: [
            {
              id: 's-far',
              name: 'far-session',
              cwd: '/work/far',
              state: 'running',
              unread: false,
              lastMsg: '',
              createdAt: 1,
              alive: true,
            },
          ],
        },
        'session.attach': {},
        'session.detach': {},
      },
      refusals: { 'session.input': { code: 'unauthorized', message: 'input refused' } },
    },
  );

  ctx.writeEntry(`127.0.0.1:${stub.port}`);
  ctx.tui.boot();

  await ctx.tui.waitFor('atc — control tower');

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('far-session');

  ctx.tui.write('/');

  await ctx.tui.waitFor('/ \u001B[93m█');

  ctx.tui.write('far-');

  await ctx.tui.waitFor('/ far-');

  ctx.tui.write(KEYS.enter);

  await waitFor(() => {
    expect(stub.requests.map((request) => request.method)).toContain('session.attach');
  });

  ctx.tui.reset();
  ctx.tui.write('refused-line');

  await ctx.tui.waitFor('box: input refused');
});

test('it opens the picker at the daemon step, lists the remote directories and starts and attaches the session on the remote daemon', async () => {
  const ctx = await setupTest();
  const remote = await ctx.startPickerRemote();
  const local = await ctx.openLocalClient();

  ctx.writeEntry(`127.0.0.1:${remote.daemon.listenPort}`);
  ctx.tui.boot();

  await ctx.tui.waitFor('atc — control tower');
  await ctx.openPickerWithRemoteUp(remote);

  expect(ctx.tui.read()).toInclude('\u001B[7mlocal');

  ctx.tui.write(KEYS.down);

  await ctx.tui.waitFor('\u001B[7mbox');

  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('spawn: workspace');
  await ctx.tui.waitFor('~/alpha-box');

  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('spawn: name');

  ctx.tui.write(`far-one${KEYS.enter}`);

  await ctx.tui.waitFor('spawn: initial prompt');

  ctx.tui.reset();
  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('REMOTE_UP');

  const remoteListed = await remote.client.sendRequest('session.list');
  const localListed = await local.sendRequest('session.list');

  expect(remoteListed['sessions']).toPartiallyContain({
    name: 'far-one',
    cwd: join(remote.directory, 'alpha-box'),
  });

  expect(localListed['sessions']).toStrictEqual([]);
});

test('it opens the picker at the agent step when the remote daemon is not up', async () => {
  const ctx = await setupTest();

  ctx.writeEntry(`127.0.0.1:${takeFreePort()}`);
  ctx.tui.boot();

  await ctx.tui.waitFor('atc — control tower');

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('box: down');

  ctx.tui.reset();
  ctx.tui.write('n');

  await ctx.tui.waitFor('spawn: agent');

  expect(ctx.tui.read()).not.toInclude('spawn: daemon');
});

test('it ends the picker with the daemon state in the status bar when the daemon it is open on drops', async () => {
  const ctx = await setupTest();
  const remote = await ctx.startPickerRemote();

  ctx.writeEntry(`127.0.0.1:${remote.daemon.listenPort}`);
  ctx.tui.boot();

  await ctx.tui.waitFor('atc — control tower');
  await ctx.openPickerWithRemoteUp(remote);

  ctx.tui.write(KEYS.down);

  await ctx.tui.waitFor('\u001B[7mbox');

  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('~/alpha-box');

  ctx.tui.reset();

  await remote.stop();
  await ctx.tui.waitFor('box: down');

  expect(ctx.tui.read()).not.toInclude('spawn: workspace');
});
