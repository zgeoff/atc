import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir, updateEnv } from '@atc/test-utils';
import { buildStubLocalProvider } from './build-stub-local-provider';

test('it builds a provider of the local kind on the daemon machine', () => {
  const provider = buildStubLocalProvider();

  expect(provider.kind).toBe('local-pty');
  expect(provider.remote).toBeFalse();
});

test('it runs a command on this machine and records it', async () => {
  const temporaryDirectory = setupTempDir('atc-stub-local-');
  const provider = buildStubLocalProvider();

  const result = await provider.runCommand({
    argv: ['bash', '-c', 'pwd; echo oops >&2; exit 3'],
    cwd: temporaryDirectory.path,
  });

  expect(result).toStrictEqual({
    exitCode: 3,
    stdout: `${temporaryDirectory.path}\n`,
    stderr: 'oops\n',
  });

  expect(provider.commands).toStrictEqual([
    { argv: ['bash', '-c', 'pwd; echo oops >&2; exit 3'], cwd: temporaryDirectory.path },
  ]);
});

test('it unpacks an archive into a directory it creates, past the TAR_OPTIONS the test inherited', async () => {
  const temporaryDirectory = setupTempDir('atc-stub-local-');
  const source = join(temporaryDirectory.path, 'source');
  const provider = buildStubLocalProvider();

  mkdirSync(join(source, 'nested'), { recursive: true });
  writeFileSync(join(source, 'nested', 'file.txt'), 'packed contents');

  const tar = Bun.spawn(['tar', '-c', '-f', '-', '-C', source, '.'], { stdout: 'pipe' });

  registerTestCleanup(async () => {
    tar.kill('SIGKILL');

    await tar.exited;
  });

  const [archive] = await Promise.all([new Response(tar.stdout).bytes(), tar.exited]);

  updateEnv('TAR_OPTIONS', '--exclude=file.txt');

  await provider.transferArchive(archive, join(temporaryDirectory.path, 'dest', 'deeper'));

  expect(
    readFileSync(join(temporaryDirectory.path, 'dest', 'deeper', 'nested', 'file.txt'), 'utf8'),
  ).toBe('packed contents');
});

test('it rejects an archive tar cannot read', () => {
  const temporaryDirectory = setupTempDir('atc-stub-local-');
  const provider = buildStubLocalProvider();

  const transfer = provider.transferArchive(
    new TextEncoder().encode('not a tar archive'),
    join(temporaryDirectory.path, 'dest'),
  );

  expect(transfer).rejects.toThrow(/tar exited/u);
});

test('it applies the config on top of the defaults', async () => {
  const provider = buildStubLocalProvider({
    remote: true,
    runCommand: () => Promise.resolve({ exitCode: 7, stdout: 'stubbed', stderr: '' }),
  });

  const result = await provider.runCommand({ argv: ['true'], cwd: '/' });

  expect(provider.remote).toBeTrue();
  expect(result).toStrictEqual({ exitCode: 7, stdout: 'stubbed', stderr: '' });
});
