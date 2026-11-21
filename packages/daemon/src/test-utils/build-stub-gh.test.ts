import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup, waitFor } from '@zgeoff/testing';
import { createStubBin } from '@zgeoff/testing/bin';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';
import { buildStubGH } from './build-stub-gh';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-stub-gh-');

  return { directory: temporaryDirectory.path };
}

test('it prints the reply of the first argument verbatim and exits with its code', async () => {
  const ctx = setupTest();

  const gh = createStubBin(ctx.directory, 'gh', {
    script: buildStubGH({
      replies: {
        repo: { stdout: '[{"description":"it\'s mine"}]\n', stderr: 'warn\n', exitCode: 3 },
        config: { stdout: 'ssh\n' },
      },
    }),
  }).path;

  const result = await run([gh, 'repo', 'list']);

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }).toStrictEqual({ exitCode: 3, stdout: '[{"description":"it\'s mine"}]\n', stderr: 'warn\n' });
});

test('it prints nothing and exits 0 for a command without a reply', async () => {
  const ctx = setupTest();

  const gh = createStubBin(ctx.directory, 'gh', {
    script: buildStubGH({ replies: { config: { stdout: 'ssh\n' } } }),
  }).path;

  const result = await run([gh, 'repo', 'list']);

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('it records the arguments of each run as one line', async () => {
  const ctx = setupTest();
  const argvFile = join(ctx.directory, "it's argv");

  const gh = createStubBin(ctx.directory, 'gh', {
    script: buildStubGH({ replies: {}, argvFile }),
  }).path;

  await run([gh, 'repo', 'list', 'acme']);
  await run([gh, 'config', 'get', 'git_protocol']);

  expect(readFileSync(argvFile, 'utf8')).toBe('repo list acme\nconfig get git_protocol\n');
});

test('it keeps a hanging command running until it is killed', async () => {
  const ctx = setupTest();
  const argvFile = join(ctx.directory, 'argv');

  const gh = createStubBin(ctx.directory, 'gh', {
    script: buildStubGH({ replies: { repo: 'hang' }, argvFile }),
  }).path;

  const subprocess = Bun.spawn([gh, 'repo', 'list']);

  registerTestCleanup(() => {
    subprocess.kill('SIGKILL');
  });

  await waitFor(() => {
    expect(readFileSync(argvFile, 'utf8')).toBe('repo list\n');
  });

  subprocess.kill('SIGKILL');

  await subprocess.exited;

  expect(subprocess.signalCode).toBe('SIGKILL');
});
