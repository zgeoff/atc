import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { createMigratedStateDB } from '@atc/store/test-utils';
import {
  KEYS,
  spawnDaemonSession,
  spawnNamedSession,
  startStubLegacyDaemon,
  startTUIHarness,
  takeFreePort,
  waitFor,
} from '@atc/test-utils';
import { startRemoteTestDaemon } from '../packages/app/src/test-utils/start-remote-test-daemon';
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

  const openLocalClient = async () => {
    const client = await openDaemonClient(join(tui.home, 'atc-daemon.sock'));

    await client.sendHello('atc/test');

    return client;
  };

  return { tui, tokenFile, writeEntry, openLocalClient };
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
