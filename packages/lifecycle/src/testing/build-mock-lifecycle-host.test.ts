import { expect, test } from 'bun:test';
import { systemClock } from '@atc/core/system-clock';
import { buildMockLifecycleHost } from './build-mock-lifecycle-host';

test('it builds a default lifecycle host', () => {
  expect(buildMockLifecycleHost()).toMatchObject({
    invocation: { argv: ['false'] },
    paths: {
      configFile: expect.toEndWith('/.config/atc/config.json'),
      stateDir: expect.toEndWith('/.local/state/atc'),
      socketPath: expect.toEndWith('/.local/state/atc/atc.sock'),
      daemonSocketPath: expect.toEndWith('/.local/state/atc/atc-daemon.sock'),
      eventsSocketPath: expect.toEndWith('/.local/state/atc/atc-events.sock'),
      daemonPidFile: expect.toEndWith('/.local/state/atc/atc-daemon.pid'),
      statusFile: expect.toEndWith('/.local/state/atc/status.json'),
      dbFile: expect.toEndWith('/.local/state/atc/atc.db'),
      mcpAuthDBFile: expect.toEndWith('/.local/state/atc/mcp-auth.db'),
      legacyFleetFile: expect.toEndWith('/.local/state/atc/fleet.json'),
      daemonRecordFile: expect.toEndWith('/.local/state/atc/daemon.json'),
      restartsDir: expect.toEndWith('/.local/state/atc/restarts'),
      restartLockFile: expect.toEndWith('/.local/state/atc/daemon-restart.lock'),
      listingCacheFile: expect.toEndWith('/.local/state/atc/listing-cache.json'),
    },
    clock: systemClock,
    procRoot: '/proc',
    restoreBootTimeoutMs: 15_000,
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockLifecycleHost({
      paths: { daemonSocketPath: '/run/atc-daemon.sock' },
      procRoot: '/tmp/proc',
    }),
  ).toMatchObject({
    invocation: { argv: ['false'] },
    paths: {
      stateDir: expect.toEndWith('/.local/state/atc'),
      daemonSocketPath: '/run/atc-daemon.sock',
    },
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
