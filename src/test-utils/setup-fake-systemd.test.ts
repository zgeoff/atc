import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupFakeSystemd } from './setup-fake-systemd';
import { setupTempDir } from './setup-temp-dir';

test('it answers a MainPID that no process holds until one is written', () => {
  using fake = setupFakeSystemd(['/bin/true']);

  const before = Bun.spawnSync([
    join(fake.binDir, 'systemctl'),
    '--user',
    'show',
    '-p',
    'MainPID',
    '--value',
    'a.service',
  ]);

  fake.writeMainPID(4321);

  const after = Bun.spawnSync([
    join(fake.binDir, 'systemctl'),
    '--user',
    'show',
    '-p',
    'MainPID',
    '--value',
    'a.service',
  ]);

  expect([before.stdout.toString().trim(), after.stdout.toString().trim()]).toStrictEqual([
    '999999',
    '4321',
  ]);
});

test('it records every systemctl call and does nothing on restart without a main pid', () => {
  using fake = setupFakeSystemd(['/bin/true']);

  const run = Bun.spawnSync([join(fake.binDir, 'systemctl'), '--user', 'restart', 'a.service']);

  expect([run.exitCode, fake.readSystemctlCalls()]).toStrictEqual([
    0,
    ['--user restart a.service'],
  ]);
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

  await Bun.sleep(300);

  expect(
    readFileSync(out, 'utf8')
      .split('\n')
      .toSorted()
      .filter((line) => line !== ''),
  ).toStrictEqual(['HOME=/h', 'PATH=/usr/bin:/bin']);

  expect(fake.readSystemdRunCalls()).toHaveLength(1);
});

test('it writes a cgroup file that places a pid in a user service', () => {
  using fake = setupFakeSystemd(['/bin/true']);

  fake.placeInUnit(77, 'atc-daemon.service');

  expect(readFileSync(join(fake.procRoot, '77', 'cgroup'), 'utf8')).toInclude(
    '/app.slice/atc-daemon.service',
  );
});
