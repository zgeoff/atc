import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { createStubBin } from './create-stub-bin';
import { createStubSystemd } from './create-stub-systemd';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

// A scratch directory for the files a test's commands write. Disposal
// removes it.
function setupTest() {
  return setupTempDir('atc-stub-systemd-');
}

test('it answers a MainPID that no process holds while none is written', () => {
  using fake = createStubSystemd(['/bin/true']);

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
  using fake = createStubSystemd(['/bin/true']);

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
  using fake = createStubSystemd(['/bin/true']);

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

test('it records a restart without a main pid and exits 0', () => {
  using fake = createStubSystemd(['/bin/true']);

  const run = Bun.spawnSync([join(fake.binDir, 'systemctl'), '--user', 'restart', 'a.service']);

  expect([run.exitCode, fake.readSystemctlCalls()]).toStrictEqual([
    0,
    ['--user restart a.service'],
  ]);
});

test('it stops the main pid and starts atc daemon on restart', async () => {
  using ctx = setupTest();

  const atc = createStubBin(
    join(ctx.dir, 'bin'),
    'atc',
    `#!/usr/bin/env bash\necho "$*" > "${join(ctx.dir, 'started')}"\n`,
  );

  using fake = createStubSystemd([atc]);

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
    expect(readFileSync(join(ctx.dir, 'started'), 'utf8')).toBe('daemon\n');
  });

  expect(main.signalCode).toBe('SIGTERM');
});

test('it runs the systemd-run command with only the setenv variables and the unit output file', async () => {
  using ctx = setupTest();
  using fake = createStubSystemd(['/bin/true']);

  const out = join(ctx.dir, 'out.log');

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
  using fake = createStubSystemd(['/bin/true']);

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
  using fake = createStubSystemd(['/bin/true']);

  fake.placeInUnit(77, 'atc-daemon.service');

  expect(readFileSync(join(fake.procRoot, '77', 'cgroup'), 'utf8')).toBe(
    `0::/user.slice/user-${userInfo().uid}.slice/user@${userInfo().uid}.service/app.slice/atc-daemon.service\n`,
  );
});

test('it removes its directory once the test finishes without a dispose', () => {
  const fake = createStubSystemd(['/bin/true']);

  onTestFinished(() => {
    expect(existsSync(dirname(fake.binDir))).toBeFalse();
  });
});

test('it removes its directory once disposed', () => {
  const fake = createStubSystemd(['/bin/true']);

  fake[Symbol.dispose]();

  expect(existsSync(dirname(fake.binDir))).toBeFalse();
});
