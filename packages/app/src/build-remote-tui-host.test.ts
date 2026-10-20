import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from '@atc/config/host';
import { buildMockLifecycleHost } from '@atc/lifecycle/testing';
import { buildMockAgentAdapter, setupTempDir } from '@atc/test-utils';
import { buildRemoteTUIHost } from './build-remote-tui-host';
import { buildMockRemoteDaemon } from './test-utils/build-mock-remote-daemon';
import { startTestDaemon } from './test-utils/start-test-daemon';

test('it holds the daemon name and a listing cache of the daemon own beside the local one', () => {
  const host = buildRemoteTUIHost(
    buildMockLifecycleHost({ paths: resolvePaths({ HOME: '/home/a' }) }),
    buildMockRemoteDaemon({ name: 'box' }),
  );

  expect(host.daemonName).toBe('box');
  expect(host.listingCacheFile).toBe('/home/a/.local/state/atc/listing-cache-box.json');
});

test('it refuses a restart, since the daemon host restarts it', () => {
  const host = buildRemoteTUIHost(buildMockLifecycleHost(), buildMockRemoteDaemon({ name: 'box' }));

  expect(host.restartDaemon('127.0.0.1:7420')).rejects.toThrowWithMessage(
    Error,
    "daemon 'box' runs on another host; restart it on that host",
  );
});

test('it boots the remote daemon with the build the invocation reads', async () => {
  const tmp = setupTempDir('atc-remote-host-');
  const tokenFile = join(tmp.path, 'box.token');

  writeFileSync(tokenFile, `${'a'.repeat(32)}\n`);

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

  const host = buildRemoteTUIHost(
    buildMockLifecycleHost({ invocation: { readBuild: () => 'atc/remote-host-test' } }),
    buildMockRemoteDaemon({
      name: 'box',
      host: '127.0.0.1',
      port: remote.daemon.listenPort,
      token: { kind: 'file', path: tokenFile },
      principal: 'laptop',
    }),
  );

  const boot = await host.bootDaemon();

  boot.client.stop();

  expect(remote.logs).toPartiallyContain(expect.stringContaining('atc/remote-host-test'));
});
