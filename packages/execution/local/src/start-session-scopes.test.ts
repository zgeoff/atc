import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStubBin } from '@atc/test-utils/create-stub-bin';
import { createStubSystemd } from '@atc/test-utils/create-stub-systemd';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { waitFor } from '@atc/test-utils/wait-for';
import { SessionScopes } from './session-scopes';
import { startSessionScopes } from './start-session-scopes';

// A stand-in service manager whose programs sit on the daemon's PATH.
function setupTest() {
  const systemd = createStubSystemd(['/bin/true']);

  return { systemd, path: `${systemd.binDir}:/usr/bin:/bin` };
}

test('it starts scopes for the main process of a user service', () => {
  const ctx = setupTest();

  ctx.systemd.writeUnitCgroup(4242, 'atc-daemon.service');

  expect(
    startSessionScopes(
      {
        PATH: ctx.path,
        SYSTEMD_EXEC_PID: '4242',
        INVOCATION_ID: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      },
      join(ctx.systemd.procRoot, '4242', 'cgroup'),
      4242,
    ),
  ).toBeInstanceOf(SessionScopes);
});

test('it stops the scopes an earlier run of the service left behind as it starts', async () => {
  const ctx = setupTest();

  ctx.systemd.writeUnitCgroup(4242, 'atc-daemon.service');
  ctx.systemd.writeBoundBy(['atc-daemon-session-ffffffff-s1-4e5f6a7b.scope']);

  startSessionScopes(
    { PATH: ctx.path, SYSTEMD_EXEC_PID: '4242', INVOCATION_ID: '0a1b2c3d4e5f60718293a4b5c6d7e8f9' },
    join(ctx.systemd.procRoot, '4242', 'cgroup'),
    4242,
  );

  await waitFor(() => {
    expect(ctx.systemd.readSystemctlCalls()).toStrictEqual([
      '--user show --property=BoundBy --value atc-daemon.service',
      '--user stop --no-block atc-daemon-session-ffffffff-s1-4e5f6a7b.scope',
    ]);
  });
});

test('it starts no scopes for a daemon systemd did not start itself', () => {
  const ctx = setupTest();

  ctx.systemd.writeUnitCgroup(4242, 'atc-daemon.service');

  expect(
    startSessionScopes(
      {
        PATH: ctx.path,
        SYSTEMD_EXEC_PID: '4100',
        INVOCATION_ID: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      },
      join(ctx.systemd.procRoot, '4242', 'cgroup'),
      4242,
    ),
  ).toBeNull();
});

test('it starts no scopes for a daemon outside any systemd service', () => {
  const ctx = setupTest();

  expect(
    startSessionScopes({ PATH: ctx.path }, join(ctx.systemd.procRoot, '4242', 'cgroup'), 4242),
  ).toBeNull();
});

test('it starts no scopes for a daemon whose cgroup is not a user service', () => {
  const ctx = setupTest();

  ctx.systemd.writeUnitCgroup(4242, 'app-terminal.scope');

  expect(
    startSessionScopes(
      {
        PATH: ctx.path,
        SYSTEMD_EXEC_PID: '4242',
        INVOCATION_ID: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      },
      join(ctx.systemd.procRoot, '4242', 'cgroup'),
      4242,
    ),
  ).toBeNull();
});

test('it starts no scopes without an invocation id for the run', () => {
  const ctx = setupTest();

  ctx.systemd.writeUnitCgroup(4242, 'atc-daemon.service');

  expect(
    startSessionScopes(
      { PATH: ctx.path, SYSTEMD_EXEC_PID: '4242' },
      join(ctx.systemd.procRoot, '4242', 'cgroup'),
      4242,
    ),
  ).toBeNull();
});

test('it starts no scopes when the service manager programs are not on the daemon PATH', () => {
  const ctx = setupTest();

  ctx.systemd.writeUnitCgroup(4242, 'atc-daemon.service');

  expect(
    startSessionScopes(
      {
        PATH: '/nonexistent',
        SYSTEMD_EXEC_PID: '4242',
        INVOCATION_ID: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      },
      join(ctx.systemd.procRoot, '4242', 'cgroup'),
      4242,
    ),
  ).toBeNull();
});

test('it starts no scopes with a systemd-run too old to leave arguments unexpanded', () => {
  const ctx = setupTest();
  const old = setupTempDir('atc-old-systemd-');

  createStubBin(old.dir, 'systemd-run', '#!/bin/sh\n# libsystemd-shared-252.so\nexec "$@"\n');

  ctx.systemd.writeUnitCgroup(4242, 'atc-daemon.service');

  expect(
    startSessionScopes(
      {
        PATH: `${old.dir}:${ctx.path}`,
        SYSTEMD_EXEC_PID: '4242',
        INVOCATION_ID: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      },
      join(ctx.systemd.procRoot, '4242', 'cgroup'),
      4242,
    ),
  ).toBeNull();
});
