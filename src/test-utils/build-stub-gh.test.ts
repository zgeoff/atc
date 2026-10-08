import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubGH } from './build-stub-gh';
import { createStubBin } from './create-stub-bin';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  const tmp = setupTempDir('atc-stub-gh-');

  return { dir: tmp.dir };
}

test('it prints the reply of the first argument verbatim and exits with its code', () => {
  const ctx = setupTest();

  const gh = createStubBin(
    ctx.dir,
    'gh',
    buildStubGH({
      replies: {
        repo: { stdout: '[{"description":"it\'s mine"}]\n', stderr: 'warn\n', exitCode: 3 },
        config: { stdout: 'ssh\n' },
      },
    }),
  );

  const result = Bun.spawnSync([gh, 'repo', 'list']);

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 3, stdout: '[{"description":"it\'s mine"}]\n', stderr: 'warn\n' });
});

test('it prints nothing and exits 0 for a command without a reply', () => {
  const ctx = setupTest();

  const gh = createStubBin(
    ctx.dir,
    'gh',
    buildStubGH({ replies: { config: { stdout: 'ssh\n' } } }),
  );

  const result = Bun.spawnSync([gh, 'repo', 'list']);

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('it records the arguments of each run as one line', () => {
  const ctx = setupTest();
  const argvFile = join(ctx.dir, "it's argv");
  const gh = createStubBin(ctx.dir, 'gh', buildStubGH({ replies: {}, argvFile }));

  Bun.spawnSync([gh, 'repo', 'list', 'acme']);
  Bun.spawnSync([gh, 'config', 'get', 'git_protocol']);

  expect(readFileSync(argvFile, 'utf8')).toBe('repo list acme\nconfig get git_protocol\n');
});

test('it keeps a hanging command running until it is killed', async () => {
  const ctx = setupTest();
  const argvFile = join(ctx.dir, 'argv');
  const gh = createStubBin(ctx.dir, 'gh', buildStubGH({ replies: { repo: 'hang' }, argvFile }));
  const proc = Bun.spawn([gh, 'repo', 'list']);

  registerTestCleanup(() => {
    proc.kill('SIGKILL');
  });

  await waitFor(() => {
    expect(readFileSync(argvFile, 'utf8')).toBe('repo list\n');
  });

  proc.kill('SIGKILL');

  await proc.exited;

  expect(proc.signalCode).toBe('SIGKILL');
});
