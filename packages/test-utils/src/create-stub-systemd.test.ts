import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { buildStubRecordingATC } from './build-stub-recording-atc';
import { createStubBin } from './create-stub-bin';
import { createStubSystemd } from './create-stub-systemd';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

// A scratch directory for the files a test's commands write, removed once
// the test finishes.
function setupTest() {
  const tmp = setupTempDir('atc-stub-systemd-');

  return { dir: tmp.dir };
}

test('it answers a MainPID that no process holds while none is written', async () => {
  const fake = createStubSystemd(['/bin/true']);

  const show = await runCommand([
    join(fake.binDir, 'systemctl'),
    '--user',
    'show',
    '-p',
    'MainPID',
    '--value',
    'a.service',
  ]);

  expect(show.stdout).toBe('999999\n');
});

test('it answers the MainPID that was written', async () => {
  const fake = createStubSystemd(['/bin/true']);

  fake.writeMainPID(4321);

  const show = await runCommand([
    join(fake.binDir, 'systemctl'),
    '--user',
    'show',
    '-p',
    'MainPID',
    '--value',
    'a.service',
  ]);

  expect(show.stdout).toBe('4321');
});

test('it answers an ExecStart that runs atc daemon', async () => {
  const fake = createStubSystemd(['/bin/true']);

  const show = await runCommand([
    join(fake.binDir, 'systemctl'),
    '--user',
    'show',
    '-p',
    'ExecStart',
    '--value',
    'a.service',
  ]);

  expect(show.stdout).toBe('{ path=/fake/bin/atc ; argv[]=/fake/bin/atc daemon ; }\n');
});

test('it records a restart without a main pid and exits 0', async () => {
  const fake = createStubSystemd(['/bin/true']);

  const run = await runCommand([join(fake.binDir, 'systemctl'), '--user', 'restart', 'a.service']);

  expect(run.exitCode).toBe(0);
  expect(fake.readSystemctlCalls()).toStrictEqual(['--user restart a.service']);
});

test('it stops the main pid and starts atc daemon on restart', async () => {
  const ctx = setupTest();

  const atc = createStubBin(
    join(ctx.dir, 'bin'),
    'atc',
    buildStubRecordingATC(join(ctx.dir, 'started')),
  );

  const fake = createStubSystemd([atc]);
  const main = Bun.spawn(['sleep', '30']);

  onTestFinished(() => {
    main.kill('SIGKILL');
  });

  fake.writeMainPID(main.pid);

  await runCommand([join(fake.binDir, 'systemctl'), '--user', 'restart', 'a.service']);

  await waitFor(() => {
    expect(readFileSync(join(ctx.dir, 'started'), 'utf8')).toBe('args:daemon\nsession:\nstdin:\n');
  });

  await main.exited;

  expect(main.signalCode).toBe('SIGTERM');
});

test('it runs the systemd-run command with only the setenv variables and the unit output file', async () => {
  const ctx = setupTest();
  const fake = createStubSystemd(['/bin/true']);
  const out = join(ctx.dir, 'out.log');

  await runCommand([
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

test('it records every systemd-run call', async () => {
  const fake = createStubSystemd(['/bin/true']);

  await runCommand([
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
  const fake = createStubSystemd(['/bin/true']);

  fake.writeUnitCgroup(77, 'atc-daemon.service');

  expect(readFileSync(join(fake.procRoot, '77', 'cgroup'), 'utf8')).toBe(
    `0::/user.slice/user-${userInfo().uid}.slice/user@${userInfo().uid}.service/app.slice/atc-daemon.service\n`,
  );
});

test('it removes its directory once the test finishes without a remove', () => {
  const fake = createStubSystemd(['/bin/true']);

  onTestFinished(() => {
    expect(existsSync(dirname(fake.binDir))).toBeFalse();
  });
});

test('it removes its directory once removed', () => {
  const fake = createStubSystemd(['/bin/true']);

  fake.remove();

  expect(existsSync(dirname(fake.binDir))).toBeFalse();
});
