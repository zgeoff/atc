import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildMockAgentAdapter,
  buildMockAgentProfile,
  resolveATCCommand,
  runATC,
  setupTempDir,
  startMCPStdio,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-mcp-remote-');

  return {
    home: temporaryDirectory.path,
    configPath: join(temporaryDirectory.path, '.config', 'atc', 'config.json'),
    tokenFile: join(temporaryDirectory.path, 'box.token'),
  };
}

test('it lists and spawns sessions on the daemon the flag names and starts no local daemon', async () => {
  const ctx = setupTest();

  // A second daemon on a loopback TCP port stands in for one on another
  // host.
  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        // a binary the daemon finds, so it lists the agent as one it can start
        adapter: buildMockAgentAdapter({ profile: buildMockAgentProfile({ bin: 'sleep' }) }),
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

  mkdirSync(join(remote.directory, 'far-dir'));
  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });
  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      daemons: {
        box: {
          address: `127.0.0.1:${remote.daemon.listenPort}`,
          principal: 'laptop',
          tokenFile: ctx.tokenFile,
        },
      },
    }),
  );

  const server = await startMCPStdio({
    home: ctx.home,
    command: [...resolveATCCommand(), 'mcp', '--daemon', 'box'],
  });

  const listed = await server.sendToolCall('atc_sessions_list', {});

  await server.spawnSession({
    cwd: join(remote.directory, 'far-dir'),
    agent: 'claude',
    name: 'far-one',
  });

  expect(listed.structured?.['sessions']).toStrictEqual([
    expect.objectContaining({ name: 'on-the-box' }),
  ]);

  await waitFor(async () => {
    const sessions = await remote.client.sendRequest('session.list');

    expect(sessions['sessions']).toPartiallyContain({
      name: 'far-one',
      cwd: join(remote.directory, 'far-dir'),
    });
  });

  expect(existsSync(join(ctx.home, 'atc-daemon.pid'))).toBe(false);
});

test('it exits naming the daemon when the flag names one the config lacks', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      daemons: {
        box: { address: '127.0.0.1:7420', principal: 'laptop', tokenFile: ctx.tokenFile },
      },
    }),
  );

  const result = await runATC({
    command: resolveATCCommand(),
    args: ['mcp', '--daemon', 'lab'],
    home: ctx.home,
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr).toInclude(
    `atc mcp: the daemons map of ${ctx.configPath} holds no daemon 'lab'; it holds box. atc did not fall back to the local daemon.`,
  );

  expect(existsSync(join(ctx.home, 'atc-daemon.pid'))).toBe(false);
});
