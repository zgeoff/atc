import { expect, test } from 'bun:test';
import { resolvePaths } from '@atc/config/host';
import { systemClock } from '@atc/core';
import { buildMockLifecycleHost } from './build-mock-lifecycle-host';

// The home is random, so each test takes it from the config file, which the
// person writes and atc only reads.
test('it builds a default lifecycle host on the paths of one home', () => {
  const host = buildMockLifecycleHost();
  const home = host.paths.configFile.slice(0, -'/.config/atc/config.json'.length);

  expect(host.paths).toStrictEqual(resolvePaths({ HOME: home }));

  expect({
    argv: host.invocation.argv,
    clock: host.clock,
    procRoot: host.procRoot,
    restoreBootTimeoutMs: host.restoreBootTimeoutMs,
  }).toStrictEqual({
    argv: ['false'],
    clock: systemClock,
    procRoot: '/proc',
    restoreBootTimeoutMs: 15_000,
  });
});

test('it applies overrides on top of the defaults', () => {
  const host = buildMockLifecycleHost({
    paths: { daemonSocketPath: '/run/atc-daemon.sock' },
    procRoot: '/tmp/proc',
  });

  const home = host.paths.configFile.slice(0, -'/.config/atc/config.json'.length);

  expect(host.paths).toStrictEqual({
    ...resolvePaths({ HOME: home }),
    daemonSocketPath: '/run/atc-daemon.sock',
  });

  expect({
    argv: host.invocation.argv,
    clock: host.clock,
    procRoot: host.procRoot,
    restoreBootTimeoutMs: host.restoreBootTimeoutMs,
  }).toStrictEqual({
    argv: ['false'],
    clock: systemClock,
    procRoot: '/tmp/proc',
    restoreBootTimeoutMs: 15_000,
  });
});

test('it reads the test build, no installed unit, and a missing systemctl by default', async () => {
  const host = buildMockLifecycleHost();

  const restarted = await host.runSystemctl(['restart', 'atc-daemon.service']);

  expect(host.invocation.readBuild()).toBe('atc/test-build');
  expect(host.findManagedUnit()).toBeNull();

  expect(restarted).toStrictEqual({
    code: 127,
    stdout: '',
    stderr: 'systemctl: command not found',
    aborted: false,
  });
});
