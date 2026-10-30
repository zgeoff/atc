import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from '@atc/config/host';
import { buildMockLifecycleHost } from '@atc/lifecycle/testing';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { setupTempDir, startStubLegacyDaemon } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { createRemoteTUIHost } from './create-remote-tui-host';
import { buildMockRemoteDaemon } from './test-utils/build-mock-remote-daemon';

test('it holds the daemon name', () => {
  const host = createRemoteTUIHost(
    buildMockLifecycleHost(),
    buildMockRemoteDaemon({ name: 'box' }),
  );

  expect(host.daemonName).toBe('box');
});

test("it keeps the daemon's listings in a cache of its own beside the local one", async () => {
  const temporaryDirectory = setupTempDir('atc-remote-host-');
  const paths = resolvePaths({ HOME: temporaryDirectory.path });
  const stateDirectory = join(temporaryDirectory.path, '.local', 'state', 'atc');

  mkdirSync(stateDirectory, { recursive: true });

  const host = createRemoteTUIHost(
    buildMockLifecycleHost({ paths }),
    buildMockRemoteDaemon({ name: 'box' }),
  );

  await host.listingCache.writeListing('github', { candidates: [], scope: 'acme', listedAt: 1 });

  expect(existsSync(join(stateDirectory, 'listing-cache-box.json'))).toBeTrue();
  expect(existsSync(join(stateDirectory, 'listing-cache.json'))).toBeFalse();
});

test('it refuses a restart, since the daemon host restarts it', () => {
  const host = createRemoteTUIHost(
    buildMockLifecycleHost(),
    buildMockRemoteDaemon({ name: 'box' }),
  );

  expect(host.restartDaemon('127.0.0.1:7420')).rejects.toThrowWithMessage(
    Error,
    "daemon 'box' runs on another host; restart it on that host",
  );
});

test('it boots the remote daemon with the build the invocation reads', () => {
  const temporaryDirectory = setupTempDir('atc-remote-host-');
  const tokenFile = join(temporaryDirectory.path, 'box.token');

  writeFileSync(tokenFile, `${'a'.repeat(32)}\n`);

  // A daemon on another protocol refuses the hello and repeats the client's
  // build in its answer, so the answer shows the build the host sent.
  const legacy = startStubLegacyDaemon(
    { hostname: '127.0.0.1', port: 0 },
    { protocol: PROTOCOL_V + 1 },
  );

  invariant(legacy.port !== null, 'the stub daemon bound no TCP port');

  const host = createRemoteTUIHost(
    buildMockLifecycleHost({ invocation: { readBuild: () => 'atc/remote-host-test' } }),
    buildMockRemoteDaemon({
      name: 'box',
      host: '127.0.0.1',
      port: legacy.port,
      token: { kind: 'file', path: tokenFile },
      principal: 'laptop',
    }),
  );

  expect(host.bootDaemon()).rejects.toThrow(
    `The daemon answered: atc/remote-host-test speaks protocol v${PROTOCOL_V}`,
  );
});
