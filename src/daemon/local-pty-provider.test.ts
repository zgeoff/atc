import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { updateEnv } from '../test-utils/update-env';
import { waitFor } from '../test-utils/wait-for';
import { LocalPTYProvider } from './local-pty-provider';

/**
 * A local pseudo-terminal provider and a temp directory for the harnesses
 * it runs.
 */
function setupTest() {
  const tmp = setupTempDir('atc-local-pty-');

  const provider = new LocalPTYProvider();

  registerTestCleanup(() => {
    provider.dispose();
  });

  return { dir: tmp.dir, provider };
}

test('it runs a harness in a pseudo-terminal that echoes typed input back', async () => {
  const ctx = setupTest();
  const output: string[] = [];

  const harness = ctx.provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'bash',
    args: ['-c', 'echo READY; read -r line; echo "GOT:$line"; sleep 30'],
    cwd: ctx.dir,
    env: { PATH: '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
  });

  registerTestCleanup(() => {
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

test('it starts a harness with TERM xterm-256color when the daemon has no TERM', async () => {
  const ctx = setupTest();

  updateEnv('TERM', undefined);

  const output: string[] = [];

  const harness = ctx.provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'bash',
    args: ['-c', 'echo "TERM:[$TERM]"; sleep 30'],
    cwd: ctx.dir,
    env: { PATH: '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
  });

  registerTestCleanup(() => {
    harness.kill();
  });

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('TERM:[xterm-256color]');
  });
});

test.each([
  { daemonTERM: 'dumb', childTERM: 'xterm-256color' },
  { daemonTERM: '', childTERM: 'xterm-256color' },
  { daemonTERM: 'screen-256color', childTERM: 'screen-256color' },
  { daemonTERM: 'xterm-kitty', childTERM: 'xterm-kitty' },
])('it starts a harness with TERM $childTERM when the daemon has TERM $daemonTERM', async (row) => {
  const ctx = setupTest();

  updateEnv('TERM', row.daemonTERM);

  const output: string[] = [];

  const harness = ctx.provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'bash',
    args: ['-c', 'echo "TERM:[$TERM]"; sleep 30'],
    cwd: ctx.dir,
    env: { PATH: '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
  });

  registerTestCleanup(() => {
    harness.kill();
  });

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude(`TERM:[${row.childTERM}]`);
  });
});

test('it keeps a TERM the caller sets for the harness over a dumb daemon TERM', async () => {
  const ctx = setupTest();

  updateEnv('TERM', 'dumb');

  const output: string[] = [];

  const harness = ctx.provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'bash',
    args: ['-c', 'echo "TERM:[$TERM]"; sleep 30'],
    cwd: ctx.dir,
    env: { PATH: '/usr/bin:/bin', TERM: 'tmux-256color' },
    cols: 80,
    rows: 24,
  });

  registerTestCleanup(() => {
    harness.kill();
  });

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('TERM:[tmux-256color]');
  });
});

test('it keeps a withheld variable out of a harness it gives a TERM', async () => {
  const ctx = setupTest();

  updateEnv('TERM', undefined);
  updateEnv('ATC_TEST_WITHHELD', 'fixture-not-a-secret');

  const output: string[] = [];

  const harness = ctx.provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'bash',
    args: ['-c', 'echo "ENV:[$TERM|$ATC_TEST_WITHHELD]"; sleep 30'],
    cwd: ctx.dir,
    env: { PATH: '/usr/bin:/bin' },
    withheldEnv: ['ATC_TEST_WITHHELD'],
    cols: 80,
    rows: 24,
  });

  registerTestCleanup(() => {
    harness.kill();
  });

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('ENV:[xterm-256color|]');
  });
});

test('it reports the exit of a killed harness', async () => {
  const ctx = setupTest();
  const exited = Promise.withResolvers<number>();

  const harness = ctx.provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'sleep',
    args: ['30'],
    cwd: ctx.dir,
    env: { PATH: '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
  });

  registerTestCleanup(() => {
    harness.kill();
  });

  harness.onExit((exit) => {
    exited.resolve(exit.exitCode);
  });

  harness.kill();

  await expect(exited.promise).toResolve();
});

test('it confirms the exit of a killed harness once its process is gone', async () => {
  const ctx = setupTest();

  const harness = ctx.provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'sleep',
    args: ['30'],
    cwd: ctx.dir,
    env: { PATH: '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
  });

  registerTestCleanup(() => {
    harness.kill();
  });

  harness.kill();

  const exited = await harness.waitForExit(2000);

  expect(exited).toBeTrue();
});

test('it reports no exit for a killed harness whose process ignores the kill', async () => {
  const ctx = setupTest();
  const output: string[] = [];

  // The harness writes the file once it has caught the hang-up, and runs on.
  const harness = ctx.provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'bash',
    args: [
      '-c',
      `trap 'echo hup > "$0"' HUP; echo "PID:$$:"; while :; do sleep 1 & wait $!; done`,
      join(ctx.dir, 'hup'),
    ],
    cwd: ctx.dir,
    env: { PATH: '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
  });

  registerTestCleanup(() => {
    harness.killForced?.();
  });

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toMatch(/PID:\d+:/);
  });

  const printed = /PID:(?<pid>\d+):/.exec(output.join(''))?.groups?.['pid'];

  invariant(printed !== undefined, 'the harness printed no pid');

  const pid = Number(printed);

  harness.kill();

  await waitFor(() => {
    expect(readFileSync(join(ctx.dir, 'hup'), 'utf8')).toBe('hup\n');
  });

  const exited = await harness.waitForExit(0);

  expect(exited).toBeFalse();
  expect(process.kill(pid, 0)).toBeTrue();
});

test('it ends a harness that ignores its kill with a forced kill', async () => {
  const ctx = setupTest();

  // The harness writes the file once it has caught the hang-up, and runs on.
  const harness = ctx.provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'bash',
    args: [
      '-c',
      `trap 'echo hup > "$0"' HUP; echo READY; while :; do sleep 1 & wait $!; done`,
      join(ctx.dir, 'hup'),
    ],
    cwd: ctx.dir,
    env: { PATH: '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
  });

  registerTestCleanup(() => {
    harness.killForced?.();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('READY');
  });

  harness.kill();

  await waitFor(() => {
    expect(readFileSync(join(ctx.dir, 'hup'), 'utf8')).toBe('hup\n');
  });

  harness.killForced?.();

  const exited = await harness.waitForExit(2000);

  expect(exited).toBeTrue();
});

test('it resizes the terminal a running harness reads its size from', async () => {
  const ctx = setupTest();
  const output: string[] = [];

  const harness = ctx.provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'bash',
    args: ['-c', 'echo READY; read -r line; echo "SIZE:$(stty size)"; sleep 30'],
    cwd: ctx.dir,
    env: { PATH: '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
  });

  registerTestCleanup(() => {
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
  const ctx = setupTest();
  const source = join(ctx.dir, 'source');

  mkdirSync(join(source, 'nested'), { recursive: true });
  writeFileSync(join(source, 'nested', 'file.txt'), 'packed contents');

  const tar = Bun.spawn(['tar', '-c', '-f', '-', '-C', source, '.'], { stdout: 'pipe' });

  registerTestCleanup(async () => {
    tar.kill('SIGKILL');

    await tar.exited;
  });

  const [archive] = await Promise.all([new Response(tar.stdout).bytes(), tar.exited]);

  await ctx.provider.transferArchive(archive, join(ctx.dir, 'dest', 'deeper'));

  expect(readFileSync(join(ctx.dir, 'dest', 'deeper', 'nested', 'file.txt'), 'utf8')).toBe(
    'packed contents',
  );
});

test('it rejects an archive tar cannot read', () => {
  const ctx = setupTest();

  const transfer = ctx.provider.transferArchive(
    new TextEncoder().encode('not a tar archive'),
    join(ctx.dir, 'dest'),
  );

  expect(transfer).rejects.toThrow(/tar exited/);
});

test('it runs a command in a directory and returns its exit code and output', async () => {
  const ctx = setupTest();

  const result = await ctx.provider.runCommand({
    argv: ['bash', '-c', 'pwd; echo oops >&2; exit 3'],
    cwd: ctx.dir,
  });

  expect(result).toStrictEqual({ exitCode: 3, stdout: `${ctx.dir}\n`, stderr: 'oops\n' });
});

test('it refuses to start a harness that requires a credential broker, which it has none of', () => {
  const ctx = setupTest();

  expect(() =>
    ctx.provider.spawnHarness({
      session: 's1',
      host: 's1',
      bin: 'true',
      args: [],
      cwd: ctx.dir,
      env: {},
      cols: 80,
      rows: 24,
      requireBroker: true,
    }),
  ).toThrow(expect.objectContaining({ code: 'auth_target_unsupported' }));
});

test('it keeps a variable the daemon started with out of a harness whose map leaves it out', async () => {
  const ctx = setupTest();

  const inner = `
import { LocalPTYProvider } from ${JSON.stringify(join(import.meta.dir, 'local-pty-provider.ts'))};
delete process.env.ATC_TEST_DELETED;
const harness = new LocalPTYProvider().spawnHarness({
  session: 's1',
  host: 's1',
  bin: 'bash',
  args: ['-c', 'echo "KEPT:[$ATC_TEST_KEPT] WITHHELD:[$ATC_TEST_WITHHELD] DELETED:[$ATC_TEST_DELETED] PARENT:[$CLAUDE_CODE_ATC_TEST]"; echo DONE'],
  cwd: process.cwd(),
  env: {},
  withheldEnv: ['ATC_TEST_WITHHELD'],
  cols: 200,
  rows: 24,
});
let output = '';
const done = Promise.withResolvers();
harness.onData((data) => {
  output += data;
  if (output.includes('DONE')) done.resolve();
});
await done.promise;
harness.kill();
console.log(output);
`;

  const proc = Bun.spawn([process.execPath, '-e', inner], {
    cwd: ctx.dir,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: ctx.dir,
      ATC_TEST_KEPT: 'synthetic',
      ATC_TEST_WITHHELD: 'synthetic',
      ATC_TEST_DELETED: 'synthetic',
      CLAUDE_CODE_ATC_TEST: 'synthetic',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  });

  registerTestCleanup(() => {
    proc.kill('SIGKILL');
  });

  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  expect(exitCode).toBe(0);
  expect(stdout).toInclude('KEPT:[synthetic] WITHHELD:[] DELETED:[] PARENT:[]');
});

test('it fails the spawn of a program the harness PATH does not hold', () => {
  const ctx = setupTest();

  expect(() =>
    ctx.provider.spawnHarness({
      session: 's1',
      host: 's1',
      bin: 'atc-test-no-such-program',
      args: [],
      cwd: ctx.dir,
      env: { PATH: '/usr/bin:/bin' },
      cols: 80,
      rows: 24,
    }),
  ).toThrowWithMessage(Error, /PTY spawn failed/);
});

test('it runs a harness whose program path holds an equals sign', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'agent=dir'));

  writeFileSync(join(ctx.dir, 'agent=dir', 'agent'), '#!/bin/sh\necho "RAN:[$1]"\nsleep 30\n', {
    mode: 0o755,
  });

  const output: string[] = [];

  const harness = ctx.provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: join(ctx.dir, 'agent=dir', 'agent'),
    args: ['first arg'],
    cwd: ctx.dir,
    env: { PATH: '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
  });

  registerTestCleanup(() => {
    harness.kill();
  });

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('RAN:[first arg]');
  });
});
