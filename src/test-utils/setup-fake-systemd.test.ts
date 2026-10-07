import { expect, onTestFinished, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';
import { setupFakeSystemd } from './setup-fake-systemd';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

test('it answers a MainPID that no process holds while none is written', () => {
  using fake = setupFakeSystemd(['/bin/true']);

  const show = Bun.spawnSync([
    join(fake.binDir, 'systemctl'),
    '--user',
    'show',
    '-p',
    'MainPID',
    '--value',
    'a.service',
  ]);

  expect(show.stdout.toString()).toBe('999999\n');
});

test('it answers the MainPID that was written', () => {
  using fake = setupFakeSystemd(['/bin/true']);

  fake.writeMainPID(4321);

  const show = Bun.spawnSync([
    join(fake.binDir, 'systemctl'),
    '--user',
    'show',
    '-p',
    'MainPID',
    '--value',
    'a.service',
  ]);

  expect(show.stdout.toString()).toBe('4321');
});

test('it answers an ExecStart that runs atc daemon', () => {
  using fake = setupFakeSystemd(['/bin/true']);

  const show = Bun.spawnSync([
    join(fake.binDir, 'systemctl'),
    '--user',
    'show',
    '-p',
    'ExecStart',
    '--value',
    'a.service',
  ]);

  expect(show.stdout.toString()).toBe('{ path=/fake/bin/atc ; argv[]=/fake/bin/atc daemon ; }\n');
});

test('it records every systemctl call and does nothing on restart without a main pid', () => {
  using fake = setupFakeSystemd(['/bin/true']);

  const run = Bun.spawnSync([join(fake.binDir, 'systemctl'), '--user', 'restart', 'a.service']);

  expect([run.exitCode, fake.readSystemctlCalls()]).toStrictEqual([
    0,
    ['--user restart a.service'],
  ]);
});

test('it stops the main pid and starts atc daemon on restart', async () => {
  await using tmp = setupTempDir('atc-fake-systemd-restart-');

  const atc = createStubBin(
    join(tmp.dir, 'bin'),
    'atc',
    `#!/usr/bin/env bash\necho "$*" > "${join(tmp.dir, 'started')}"\n`,
  );

  using fake = setupFakeSystemd([atc]);

  const main = Bun.spawn(['sleep', '30']);

  onTestFinished(() => {
    main.kill('SIGKILL');
  });

  fake.writeMainPID(main.pid);

  // The restart waits for the main pid to go, which needs this process
  // free to reap it, so it runs without blocking.
  const restart = Bun.spawn([join(fake.binDir, 'systemctl'), '--user', 'restart', 'a.service']);

  await restart.exited;

  await waitFor(() => {
    expect(readFileSync(join(tmp.dir, 'started'), 'utf8')).toBe('daemon\n');
  });

  expect(main.signalCode).toBe('SIGTERM');
});

test('it runs the systemd-run command with only the setenv variables and the unit output file', async () => {
  using fake = setupFakeSystemd(['/bin/true']);
  using tmp = setupTempDir('atc-fake-systemd-run-');

  const out = join(tmp.dir, 'out.log');

  Bun.spawnSync([
    join(fake.binDir, 'systemd-run'),
    '--user',
    '--collect',
    '--quiet',
    '--unit',
    'u1',
    `--property=StandardOutput=append:${out}`,
    '--setenv=HOME=/h',
    '--setenv=PATH=/usr/bin:/bin',
    '--',
    '/usr/bin/env',
  ]);

  await waitFor(() => {
    expect(
      readFileSync(out, 'utf8')
        .split('\n')
        .toSorted()
        .filter((line) => line !== ''),
    ).toStrictEqual(['HOME=/h', 'PATH=/usr/bin:/bin']);
  });
});

test('it records every systemd-run call', () => {
  using fake = setupFakeSystemd(['/bin/true']);

  Bun.spawnSync([
    join(fake.binDir, 'systemd-run'),
    '--user',
    '--unit',
    'u1',
    '--setenv=HOME=/h',
    '--',
    '/bin/true',
  ]);

  expect(fake.readSystemdRunCalls()).toStrictEqual([
    '--user --unit u1 --setenv=HOME=/h -- /bin/true',
  ]);
});

test('it writes a cgroup file that places a pid in a user service', () => {
  using fake = setupFakeSystemd(['/bin/true']);

  fake.placeInUnit(77, 'atc-daemon.service');

  expect(readFileSync(join(fake.procRoot, '77', 'cgroup'), 'utf8')).toBe(
    `0::/user.slice/user-${userInfo().uid}.slice/user@${userInfo().uid}.service/app.slice/atc-daemon.service\n`,
  );
});
