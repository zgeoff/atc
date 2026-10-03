import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { LocalPTYProvider } from './local-pty-provider';

function setupTest() {
  const tmp = setupTempDir('atc-local-pty-');

  return {
    dir: tmp.dir,
    provider: new LocalPTYProvider(),
    [Symbol.dispose]: tmp[Symbol.dispose],
  };
}

test('it runs a harness in a pseudo-terminal that echoes typed input back', async () => {
  using local = setupTest();

  const output: string[] = [];

  const harness = local.provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'bash',
    args: ['-c', 'echo READY; read -r line; echo "GOT:$line"; sleep 30'],
    cwd: local.dir,
    env: { PATH: '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
  });

  onTestFinished(() => {
    harness.kill();
  });

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('READY');
  });

  harness.write('ping\r');

  await waitFor(() => {
    expect(output.join('')).toInclude('GOT:ping');
  });
});

test('it reports the exit of a killed harness', async () => {
  using local = setupTest();

  const exited = Promise.withResolvers<number>();

  const harness = local.provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'sleep',
    args: ['30'],
    cwd: local.dir,
    env: { PATH: '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
  });

  harness.onExit((exit) => {
    exited.resolve(exit.exitCode);
  });

  harness.kill();

  await expect(exited.promise).toResolve();
});

test('it confirms the exit of a killed harness once its process is gone', async () => {
  using local = setupTest();

  const harness = local.provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'sleep',
    args: ['30'],
    cwd: local.dir,
    env: { PATH: '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
  });

  harness.kill();

  const exited = await harness.waitForExit(2000);

  expect(exited).toBeTrue();
});

test('it reports no exit for a killed harness whose process ignores the kill', async () => {
  using local = setupTest();

  const output: string[] = [];

  const harness = local.provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'bash',
    args: ['-c', `trap '' HUP; echo "PID:$$:"; exec sleep 10`],
    cwd: local.dir,
    env: { PATH: '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
  });

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toMatch(/PID:\d+:/);
  });

  const match = /PID:(?<pid>\d+):/.exec(output.join(''));
  const printed = match?.groups?.['pid'];

  if (printed === undefined) {
    throw new Error('the harness printed no pid');
  }

  const pid = Number(printed);

  onTestFinished(() => {
    process.kill(pid, 'SIGKILL');
  });

  harness.kill();

  const exited = await harness.waitForExit(200);

  expect(exited).toBeFalse();
  expect(process.kill(pid, 0)).toBeTrue();
});

test('it ends a harness that ignores its kill with a forced kill', async () => {
  using local = setupTest();

  const output: string[] = [];

  const harness = local.provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'bash',
    args: ['-c', `trap '' HUP; echo READY; exec sleep 10`],
    cwd: local.dir,
    env: { PATH: '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
  });

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('READY');
  });

  harness.kill();

  const survived = await harness.waitForExit(200);

  harness.killForced?.();

  const exited = await harness.waitForExit(2000);

  expect(survived).toBeFalse();
  expect(exited).toBeTrue();
});

test('it resizes the terminal a running harness reads its size from', async () => {
  using local = setupTest();

  const output: string[] = [];

  const harness = local.provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'bash',
    args: ['-c', 'echo READY; read -r line; echo "SIZE:$(stty size)"; sleep 30'],
    cwd: local.dir,
    env: { PATH: '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
  });

  onTestFinished(() => {
    harness.kill();
  });

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('READY');
  });

  harness.resize(100, 40);
  harness.write('\r');

  await waitFor(() => {
    expect(output.join('')).toInclude('SIZE:40 100');
  });
});

test('it unpacks a tar archive into a directory it creates', async () => {
  using local = setupTest();

  const source = join(local.dir, 'source');

  mkdirSync(join(source, 'nested'), { recursive: true });
  writeFileSync(join(source, 'nested', 'file.txt'), 'packed contents');

  const archive = Bun.spawnSync(['tar', '-c', '-f', '-', '-C', source, '.']).stdout;

  await local.provider.transferArchive(archive, join(local.dir, 'dest', 'deeper'));

  expect(readFileSync(join(local.dir, 'dest', 'deeper', 'nested', 'file.txt'), 'utf8')).toBe(
    'packed contents',
  );
});

test('it rejects an archive tar cannot read', () => {
  using local = setupTest();

  const transfer = local.provider.transferArchive(
    new TextEncoder().encode('not a tar archive'),
    join(local.dir, 'dest'),
  );

  expect(transfer).rejects.toThrow(/tar exited/);
});

test('it runs a command in a directory and returns its exit code and output', async () => {
  using local = setupTest();

  const result = await local.provider.runCommand({
    argv: ['bash', '-c', 'pwd; echo oops >&2; exit 3'],
    cwd: local.dir,
  });

  expect(result).toStrictEqual({ exitCode: 3, stdout: `${local.dir}\n`, stderr: 'oops\n' });
});
