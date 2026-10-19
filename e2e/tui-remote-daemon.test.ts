import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { buildDirsSource } from '@atc/source-dirs';
import {
  KEYS,
  buildMockAgentAdapter,
  startStubLegacyDaemon,
  startTUIHarness,
  waitFor,
} from '@atc/test-utils';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

function setupTest() {
  const tui = startTUIHarness();

  return { tui, tokenFile: join(tui.home, 'box.token') };
}

test('it shows the fleet of the remote daemon the flag selects and starts no local daemon', async () => {
  const ctx = setupTest();

  // A second daemon on a loopback TCP port stands in for one on another
  // host.
  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['laptop', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  if (remote.daemon.listenPort === null) {
    throw new Error('the remote daemon bound no TCP port');
  }

  await remote.client.sendRequest('session.spawn', {
    cwd: remote.dir,
    agent: 'claude',
    name: 'on-the-box',
    cols: 80,
    rows: 24,
  });

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  ctx.tui.writeConfig({
    daemons: {
      box: {
        address: `127.0.0.1:${remote.daemon.listenPort}`,
        principal: 'laptop',
        tokenFile: ctx.tokenFile,
      },
    },
  });

  ctx.tui.boot(['--daemon', 'box']);

  await ctx.tui.waitFor('atc — control tower');

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('┌ sessions ');
  await ctx.tui.waitFor('on-the-box');

  // The client draws the status bar on a 50 ms timer after it draws the
  // list, so the list can show before the daemon's name does.
  await ctx.tui.waitFor(' atc@box ▏');

  expect(existsSync(join(ctx.tui.home, 'atc-daemon.pid'))).toBe(false);
});

test("it lists only the remote daemon's directories and spawns in the first of them", async () => {
  const ctx = setupTest();

  // The remote daemon's home is its own temp directory, so no path on it
  // is a path under the client's home.
  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['laptop', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
        sources: [
          buildDirsSource({
            roots: [],
            collectZoxideDirs: () => Promise.resolve([]),
            homeDir: paths.dir,
          }),
        ],
      };
    },
  });

  if (remote.daemon.listenPort === null) {
    throw new Error('the remote daemon bound no TCP port');
  }

  mkdirSync(join(remote.dir, 'alpha-box'));

  await remote.client.sendRequest('session.spawn', {
    cwd: join(remote.dir, 'alpha-box'),
    agent: 'claude',
    name: 'earlier',
    cols: 80,
    rows: 24,
  });

  mkdirSync(join(ctx.tui.home, 'projects', 'client-proj'), { recursive: true });
  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  ctx.tui.writeConfig({
    dirs: { roots: [join(ctx.tui.home, 'projects')] },
    daemons: {
      box: {
        address: `127.0.0.1:${remote.daemon.listenPort}`,
        principal: 'laptop',
        tokenFile: ctx.tokenFile,
      },
    },
  });

  ctx.tui.boot(['--daemon', 'box']);

  await ctx.tui.waitFor('atc — control tower');

  ctx.tui.write('n');

  await ctx.tui.waitFor('spawn: agent');

  ctx.tui.reset();
  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('spawn: directory on the daemon host');
  await ctx.tui.waitFor('~/alpha-box');

  expect(ctx.tui.read()).not.toInclude('client-proj');

  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('spawn: name');

  ctx.tui.write(`far-one${KEYS.enter}`);

  await ctx.tui.waitFor('spawn: initial prompt');

  ctx.tui.write(KEYS.enter);

  const spawned = { name: 'far-one', cwd: join(remote.dir, 'alpha-box') };

  await waitFor(async () => {
    const listed = await remote.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain(spawned);
  });
}, 20_000);

test("it completes and resolves a typed ~ path on the remote daemon's host", async () => {
  const ctx = setupTest();

  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['laptop', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
        sources: [
          buildDirsSource({
            roots: [],
            collectZoxideDirs: () => Promise.resolve([]),
            homeDir: paths.dir,
          }),
        ],
      };
    },
  });

  if (remote.daemon.listenPort === null) {
    throw new Error('the remote daemon bound no TCP port');
  }

  // Only the remote daemon's host holds beta-box, so a completion read on
  // the client's host finds nothing.
  mkdirSync(join(remote.dir, 'beta-box'));
  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  ctx.tui.writeConfig({
    daemons: {
      box: {
        address: `127.0.0.1:${remote.daemon.listenPort}`,
        principal: 'laptop',
        tokenFile: ctx.tokenFile,
      },
    },
  });

  ctx.tui.boot(['--daemon', 'box']);

  await ctx.tui.waitFor('atc — control tower');

  ctx.tui.write('n');

  await ctx.tui.waitFor('spawn: agent');

  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('spawn: directory on the daemon host');

  ctx.tui.reset();
  ctx.tui.write('~/bet');

  await ctx.tui.waitFor('~/beta-box');

  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('spawn: name');

  ctx.tui.write(`far-two${KEYS.enter}`);

  await ctx.tui.waitFor('spawn: initial prompt');

  ctx.tui.write(KEYS.enter);

  const spawned = { name: 'far-two', cwd: join(remote.dir, 'beta-box') };

  await waitFor(async () => {
    const listed = await remote.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain(spawned);
  });
}, 20_000);

test('it exits with the refusal when a reconnect to the remote daemon is refused its token', async () => {
  const ctx = setupTest();

  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['laptop', ['local']]]),
        listen: {
          host: '127.0.0.1',
          port: 0,
          tokenFile: join(paths.dir, 'gateway-token'),
          failureDelayMs: 0,
        },
      };
    },
  });

  if (remote.daemon.listenPort === null) {
    throw new Error('the remote daemon bound no TCP port');
  }

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  ctx.tui.writeConfig({
    daemons: {
      box: {
        address: `127.0.0.1:${remote.daemon.listenPort}`,
        principal: 'laptop',
        tokenFile: ctx.tokenFile,
      },
    },
  });

  ctx.tui.boot(['--daemon', 'box']);

  await ctx.tui.waitFor('atc — control tower');

  // The daemon drops the token the client holds, which closes its
  // connection, so the client's reconnect presents a token it refuses.
  writeFileSync(join(remote.dir, 'gateway-token'), `${'b'.repeat(32)}\n`);

  remote.daemon.refreshTokens();

  const exitCode = await ctx.tui.waitForExit();

  expect(exitCode).toBe(1);

  expect(ctx.tui.read()).toInclude(
    `atc: daemon 'box' at 127.0.0.1:${remote.daemon.listenPort} refused the token: daemon.hello over TCP needs a valid bearer token. The TUI did not fall back to the local daemon.`,
  );
});

test('it exits with the daemon and its address when the remote daemon is unreachable, starting no local daemon', async () => {
  const ctx = setupTest();

  // A port the kernel handed out and this test then freed, so nothing
  // listens on it.
  const freed = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = freed.port;

  freed.stop(true);

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  ctx.tui.writeConfig({
    daemons: {
      box: { address: `127.0.0.1:${port}`, principal: 'laptop', tokenFile: ctx.tokenFile },
    },
  });

  ctx.tui.boot(['--daemon', 'box']);

  const exitCode = await ctx.tui.waitForExit();

  expect(exitCode).toBe(1);

  expect(ctx.tui.read()).toInclude(
    `atc: cannot reach daemon 'box' at 127.0.0.1:${port}: ECONNREFUSED. The TUI did not fall back to the local daemon.`,
  );

  expect(existsSync(join(ctx.tui.home, 'atc-daemon.pid'))).toBe(false);
});

test('it exits with both builds and versions when the remote daemon speaks another protocol, starting no local daemon', async () => {
  const ctx = setupTest();

  const legacy = startStubLegacyDaemon(
    { hostname: '127.0.0.1', port: 0 },
    { protocol: PROTOCOL_V + 1 },
  );

  if (legacy.port === null) {
    throw new Error('the stub daemon bound no TCP port');
  }

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  ctx.tui.writeConfig({
    daemons: {
      box: { address: `127.0.0.1:${legacy.port}`, principal: 'laptop', tokenFile: ctx.tokenFile },
    },
  });

  ctx.tui.boot(['--daemon', 'box']);

  const exitCode = await ctx.tui.waitForExit();

  expect(exitCode).toBe(1);

  expect(ctx.tui.read()).toInclude(
    `atc: daemon 'box' at 127.0.0.1:${legacy.port} speaks another protocol than this client,`,
  );

  expect(ctx.tui.read()).toInclude(
    `speaks protocol v${PROTOCOL_V}, daemon atc/legacy-build speaks v${PROTOCOL_V + 1}`,
  );

  expect(ctx.tui.read()).toInclude('The TUI did not fall back to the local daemon.');
  expect(existsSync(join(ctx.tui.home, 'atc-daemon.pid'))).toBe(false);
});

test('it exits with the names the config holds when the flag selects a daemon the config lacks', async () => {
  const ctx = setupTest();

  ctx.tui.writeConfig({
    daemons: {
      box: { address: '127.0.0.1:7420', principal: 'laptop', tokenFile: ctx.tokenFile },
    },
  });

  ctx.tui.boot(['--daemon', 'lab']);

  const exitCode = await ctx.tui.waitForExit();

  expect(exitCode).toBe(1);

  expect(ctx.tui.read()).toInclude(
    `atc: the daemons map of ${ctx.tui.configPath} holds no daemon 'lab'; it holds box. The TUI did not fall back to the local daemon.`,
  );

  expect(existsSync(join(ctx.tui.home, 'atc-daemon.pid'))).toBe(false);
});
