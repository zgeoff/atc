import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { buildStubRecordingATC } from '@atc/core/test-utils/build-stub-recording-atc';
import { waitFor } from '@zgeoff/testing';
import { createStubBin } from '@zgeoff/testing/bin';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';
import { createStubSystemd } from './create-stub-systemd';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-stub-systemd-');

  return { directory: temporaryDirectory.path };
}

test('it answers a MainPID that no process holds while none is written', async () => {
  const fake = createStubSystemd(['/bin/true']);

  const show = await run([
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

  const show = await run([
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

  const show = await run([
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

  const result = await run([join(fake.binDir, 'systemctl'), '--user', 'restart', 'a.service']);

  expect(result.exitCode).toBe(0);
  expect(fake.readSystemctlCalls()).toStrictEqual(['--user restart a.service']);
});

test('it stops the main pid and starts atc daemon on restart', async () => {
  const ctx = setupTest();

  const atc = createStubBin(join(ctx.directory, 'bin'), 'atc', {
    script: buildStubRecordingATC(join(ctx.directory, 'started')),
  }).path;

  const fake = createStubSystemd([atc]);
  const main = Bun.spawn(['sleep', '30']);

  onTestFinished(() => {
    main.kill('SIGKILL');
  });

  fake.writeMainPID(main.pid);

  await run([join(fake.binDir, 'systemctl'), '--user', 'restart', 'a.service']);

  await waitFor(() => {
    expect(readFileSync(join(ctx.directory, 'started'), 'utf8')).toBe(
      'args:daemon\nsession:\nstdin:\n',
    );
  });

  await main.exited;

  expect(main.signalCode).toBe('SIGTERM');
});

test('it runs the systemd-run command with only the setenv variables and the unit output file', async () => {
  const ctx = setupTest();
  const fake = createStubSystemd(['/bin/true']);
  const out = join(ctx.directory, 'out.log');

  await run([
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

  await run([
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

test('it prints no bound units while none are written', async () => {
  const fake = createStubSystemd(['/bin/true']);

  const show = await run([
    join(fake.binDir, 'systemctl'),
    '--user',
    'show',
    '--property=BoundBy',
    '--value',
    'a.service',
  ]);

  expect(show.stdout).toBe('');
});

test('it prints the bound units that were written', async () => {
  const fake = createStubSystemd(['/bin/true']);

  fake.writeBoundBy(['a-session-1.scope', 'other.scope']);

  const show = await run([
    join(fake.binDir, 'systemctl'),
    '--user',
    'show',
    '--property=BoundBy',
    '--value',
    'a.service',
  ]);

  expect(show.stdout).toBe('a-session-1.scope other.scope\n');
});

test('it replaces systemd-run with the scope command in its own process and environment', async () => {
  const fake = createStubSystemd(['/bin/true']);

  const scope = Bun.spawn(
    [
      join(fake.binDir, 'systemd-run'),
      '--user',
      '--scope',
      '--unit=a-session-1.scope',
      '--',
      'bash',
      '-c',
      'echo "pid:$$ scoped:$SCOPED"',
    ],
    { env: { PATH: process.env['PATH'], SCOPED: 'yes' }, stdout: 'pipe' },
  );

  const stdout = await new Response(scope.stdout).text();

  expect(stdout).toBe(`pid:${scope.pid} scoped:yes\n`);

  expect(fake.readSystemdRunCalls()).toStrictEqual([
    '--user --scope --unit=a-session-1.scope -- bash -c echo "pid:$$ scoped:$SCOPED"',
  ]);
});

test('it writes a systemd-run that holds the name of the systemd 261 shared library', () => {
  const fake = createStubSystemd(['/bin/true']);

  expect(readFileSync(join(fake.binDir, 'systemd-run'), 'utf8')).toInclude(
    'libsystemd-shared-261.so',
  );
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
