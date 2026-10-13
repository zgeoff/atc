import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStubSystemd } from '@atc/test-utils/create-stub-systemd';
import { SessionScopes } from './session-scopes';

// A stand-in service manager that the scopes reach through its programs.
function setupTest() {
  const systemd = createStubSystemd(['/bin/true']);

  return {
    systemd,
    systemctl: join(systemd.binDir, 'systemctl'),
    systemdRun: join(systemd.binDir, 'systemd-run'),
  };
}

test('it starts a command in a scope of its own bound to the daemon service', () => {
  const ctx = setupTest();

  const scopes = new SessionScopes({
    unit: 'atc-daemon.service',
    systemctl: ctx.systemctl,
    systemdRun: ctx.systemdRun,
  });

  const command = scopes.buildCommand('s1', ['/usr/bin/env', '--', '/bin/claude']);

  expect(command.file).toBe(ctx.systemdRun);

  expect(command.args.join('\n')).toMatch(
    /^--user\n--scope\n--quiet\n--collect\n--unit=atc-daemon-session-s1-[\da-f]{8}\.scope\n--description=atc session s1\n--property=BindsTo=atc-daemon\.service\n--\n\/usr\/bin\/env\n--\n\/bin\/claude$/,
  );
});

test('it gives each start of one session a scope name of its own', () => {
  const ctx = setupTest();

  const scopes = new SessionScopes({
    unit: 'atc-daemon.service',
    systemctl: ctx.systemctl,
    systemdRun: ctx.systemdRun,
  });

  const first = scopes.buildCommand('s1', ['/bin/true']);
  const second = scopes.buildCommand('s1', ['/bin/true']);

  expect(first.args[4]).not.toBe(second.args[4]);
});

test('it replaces each character a unit name cannot hold in the scope name', () => {
  const ctx = setupTest();

  const scopes = new SessionScopes({
    unit: 'atc-daemon.service',
    systemctl: ctx.systemctl,
    systemdRun: ctx.systemdRun,
  });

  expect(scopes.buildCommand('a/b c', ['/bin/true']).args[4]).toMatch(
    /^--unit=atc-daemon-session-a_b_c-[\da-f]{8}\.scope$/,
  );
});

test('it stops the scopes an earlier daemon of the service left behind', async () => {
  const ctx = setupTest();

  const scopes = new SessionScopes({
    unit: 'atc-daemon.service',
    systemctl: ctx.systemctl,
    systemdRun: ctx.systemdRun,
  });

  ctx.systemd.writeBoundBy([
    'atc-daemon-session-s1-0a1b2c3d.scope',
    'atc-daemon-session-s2-4e5f6a7b.scope',
  ]);

  await scopes.stopLeftovers();

  expect(ctx.systemd.readSystemctlCalls()).toStrictEqual([
    '--user show --property=BoundBy --value atc-daemon.service',
    '--user stop --no-block atc-daemon-session-s1-0a1b2c3d.scope atc-daemon-session-s2-4e5f6a7b.scope',
  ]);
});

test('it never stops a bound unit that is not a session scope of the service', async () => {
  const ctx = setupTest();

  const scopes = new SessionScopes({
    unit: 'atc-daemon.service',
    systemctl: ctx.systemctl,
    systemdRun: ctx.systemdRun,
  });

  ctx.systemd.writeBoundBy([
    'atc-daemon-dev-session-s1-0a1b2c3d.scope',
    'atc-daemon-session-s1-0a1b2c3d.service',
    'helper.scope',
  ]);

  await scopes.stopLeftovers();

  expect(ctx.systemd.readSystemctlCalls()).toStrictEqual([
    '--user show --property=BoundBy --value atc-daemon.service',
  ]);
});

test('it never stops a scope this daemon started as a leftover', async () => {
  const ctx = setupTest();

  const scopes = new SessionScopes({
    unit: 'atc-daemon.service',
    systemctl: ctx.systemctl,
    systemdRun: ctx.systemdRun,
  });

  const started = scopes.buildCommand('s1', ['/bin/true']).args[4]?.replace('--unit=', '');

  ctx.systemd.writeBoundBy([String(started)]);

  await scopes.stopLeftovers();

  expect(ctx.systemd.readSystemctlCalls()).toStrictEqual([
    '--user show --property=BoundBy --value atc-daemon.service',
  ]);
});

test('it stops every scope it started a command in', async () => {
  const ctx = setupTest();

  const scopes = new SessionScopes({
    unit: 'atc-daemon.service',
    systemctl: ctx.systemctl,
    systemdRun: ctx.systemdRun,
  });

  const first = scopes.buildCommand('s1', ['/bin/true']).args[4]?.replace('--unit=', '');
  const second = scopes.buildCommand('s2', ['/bin/true']).args[4]?.replace('--unit=', '');

  await scopes.stop();

  expect(ctx.systemd.readSystemctlCalls()).toStrictEqual([
    `--user stop --no-block ${first} ${second}`,
  ]);
});

test('it queues no stop when it started no scope', async () => {
  const ctx = setupTest();

  const scopes = new SessionScopes({
    unit: 'atc-daemon.service',
    systemctl: ctx.systemctl,
    systemdRun: ctx.systemdRun,
  });

  await scopes.stop();

  expect(ctx.systemd.readSystemctlCalls()).toStrictEqual([]);
});
