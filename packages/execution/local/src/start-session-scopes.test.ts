import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStubSystemd } from '@atc/test-utils/create-stub-systemd';
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
      { PATH: ctx.path, SYSTEMD_EXEC_PID: '4242' },
      join(ctx.systemd.procRoot, '4242', 'cgroup'),
      4242,
    ),
  ).toBeInstanceOf(SessionScopes);
});

test('it stops the scopes an earlier daemon of the service left behind as it starts', async () => {
  const ctx = setupTest();

  ctx.systemd.writeUnitCgroup(4242, 'atc-daemon.service');
  ctx.systemd.writeBoundBy(['atc-daemon-session-s1-0a1b2c3d.scope']);

  startSessionScopes(
    { PATH: ctx.path, SYSTEMD_EXEC_PID: '4242' },
    join(ctx.systemd.procRoot, '4242', 'cgroup'),
    4242,
  );

  await waitFor(() => {
    expect(ctx.systemd.readSystemctlCalls()).toStrictEqual([
      '--user show --property=BoundBy --value atc-daemon.service',
      '--user stop --no-block atc-daemon-session-s1-0a1b2c3d.scope',
    ]);
  });
});

test('it starts no scopes for a daemon systemd did not start itself', () => {
  const ctx = setupTest();

  ctx.systemd.writeUnitCgroup(4242, 'atc-daemon.service');

  expect(
    startSessionScopes(
      { PATH: ctx.path, SYSTEMD_EXEC_PID: '4100' },
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
      { PATH: '/nonexistent', SYSTEMD_EXEC_PID: '4242' },
      join(ctx.systemd.procRoot, '4242', 'cgroup'),
      4242,
    ),
  ).toBeNull();
});
