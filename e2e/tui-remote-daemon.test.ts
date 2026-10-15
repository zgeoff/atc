import { expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_V } from '@atc/protocol/protocol';
import { buildMockAgentAdapter } from '@atc/test-utils/build-mock-agent-adapter';
import { KEYS } from '@atc/test-utils/keys';
import { startStubLegacyDaemon } from '@atc/test-utils/start-stub-legacy-daemon';
import { startTUIHarness } from '@atc/test-utils/start-tui-harness';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

/**
 * A client home whose config may name a remote daemon, and the token file
 * that daemon entry reads.
 */
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

  expect(ctx.tui.read()).toInclude(' atc@box ▏');
  expect(existsSync(join(ctx.tui.home, 'atc-daemon.pid'))).toBe(false);
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
